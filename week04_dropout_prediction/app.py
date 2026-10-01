import time
import pandas as pd
from ucimlrepo import fetch_ucirepo
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, recall_score

# 1. UCI에서 대학생 기록을 불러온다. (학생 1명 = 1행) · 从UCI加载大学生记录（每名学生一行）
dataset = fetch_ucirepo(id=697)
data = dataset.data.original.copy()

# 2. 긴 열 이름을 짧게 바꾼다. · 将较长的列名改为简短名称。
data = data.rename(columns={
    "Admission grade": "admission_grade",
    "Age at enrollment": "age",
    "Scholarship holder": "scholarship",
    "Tuition fees up to date": "tuition_paid",
    "Curricular units 1st sem (enrolled)": "sem1_enrolled",
    "Curricular units 1st sem (approved)": "sem1_passed",
    "Curricular units 1st sem (grade)": "sem1_grade",
})

# 3. 입력(X)과 실제 결과(y)을 정한다. 입력은 1학기가 끝난 시점에 이미 알 수 있는 값만 쓴다. · 确定输入(X)与实际结果(y)。输入仅使用第一学期结束时已知的信息。
columns = [
    "admission_grade",  # 입학 성적 (0~200) · 入学成绩（0~200）
    "age",              # 입학 나이 · 入学年龄
    "scholarship",      # 장학금 받음(1) / 안 받음(0) · 有奖学金(1) / 无奖学金(0)
    "tuition_paid",     # 등록금 납부함(1) / 밀림(0) · 已缴学费(1) / 拖欠学费(0)
    "sem1_enrolled",    # 1학기 신청 과목 수 · 第一学期选课数
    "sem1_passed",      # 1학기 통과 과목 수 · 第一学期通过科目数
    "sem1_grade",       # 1학기 평균 성적 (0~20) · 第一学期平均成绩（0~20）
]
X = data[columns]
y = (data["Target"] == "Dropout").astype(int)   # 대학 학업 중단(1) / 학업 중단 안 함(0) · 退学(1) / 未退学(0)

# 4. 80%는 과거 학생(학습용), 20%는 새 학생(예측용)으로 나눈다. · 将80%作为训练数据，20%作为新学生模拟预测数据。
X_train, X_new, y_train, y_new = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)

# 5. 과거 학생으로 Random Forest를 학습한다. · 使用训练集中的学生记录训练Random Forest。
model = RandomForestClassifier(n_estimators=100, random_state=42, class_weight="balanced")
model.fit(X_train, y_train)

# 6. 새 학생이 한 명씩 들어온다고 보고 예측 → 행동 → 확인한다. · 模拟新学生逐一到来，进行预测 → 行动 → 核对。
print("=== 1학기가 끝났다. 새 학생 10명을 확인한다 ===\n")
for i in range(10):
    student = X_new.iloc[[i]]
    s = data.loc[student.index[0]]   # 화면 표시용: 이 학생의 원래 기록 · 用于屏幕显示：该学生的原始记录
    risk = model.predict_proba(student)[0, 1]
    action = "상담 연락" if risk >= 0.5 else "조치 없음"
    actual = "대학 학업 중단" if y_new.iloc[i] == 1 else "학업 중단 안 함"
    print(f"학생 {i + 1:2d} | {int(s['age'])}세 · 1학기 {int(s['sem1_enrolled'])}과목 중 "
          f"{int(s['sem1_passed'])}과목 통과 · 평균 {s['sem1_grade']:.1f}")
    print(f"        → 학업 중단 위험 {risk * 100:3.0f}% → {action} | 실제: {actual}\n")
    time.sleep(1)

# 7. 새 학생 전체로 모델을 평가하고 기준선과 비교한다. · 使用全部预测集评估模型，并与基准方法比较。
predictions = model.predict(X_new)
baseline = [0] * len(y_new)   # 기준선: 모두 "학업 중단 안 함"이라고 답하는 방법 · 基准方法：对所有学生都预测为“未退学”。

print(f"=== 새 학생 {len(y_new)}명 전체 결과 ===")
print("모델 정확도:", round(accuracy_score(y_new, predictions) * 100, 1), "%")
print("기준선 정확도:", round(accuracy_score(y_new, baseline) * 100, 1), "%")
print("실제 학업을 중단한 학생 중 모델이 찾아낸 비율:", round(recall_score(y_new, predictions) * 100, 1), "%")
print("기준선이 찾아낸 비율:", round(recall_score(y_new, baseline) * 100, 1), "%")

# 8. 모델이 어떤 입력을 중요하게 썼는지 확인한다. · 查看模型认为哪些输入更重要。
print("\n입력별 중요도:")
print(pd.Series(model.feature_importances_, index=columns).sort_values(ascending=False).round(3))