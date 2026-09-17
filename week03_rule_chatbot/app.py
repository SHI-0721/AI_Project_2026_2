import os
from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

client = OpenAI(
    api_key=os.getenv("DASHSCOPE_API_KEY"),
    base_url=os.getenv("DASHSCOPE_BASE_URL")
)

rules_path = BASE_DIR / "rules.txt"

if not rules_path.exists():
    raise FileNotFoundError("rules.txt 파일을 찾을 수 없습니다.")

rules_text = rules_path.read_text(encoding="utf-8")

print("동아대학교 한림생활관 이용규정 Q&A 챗봇")
print("규정에 대해 질문하세요. 종료하려면 exit를 입력하세요.")

while True:
    question = input("\nQuestion: ").strip()

    if question.lower() == "exit":
        print("Chatbot closed.")
        break

    if not question:
        print("질문을 입력하세요.")
        continue

    prompt = f"""
You are a Q&A chatbot for a website or service.

Rules document:
{rules_text}

User question:
{question}

Instructions:
1. Use only the rules document.
2. Answer in the same language as the user's question.
3. Give a short and clear answer.
4. Include the rule number and the relevant sentence as evidence.
5. If the rules document does not contain the answer, clearly say that the information cannot be confirmed from the provided rules.
6. Do not guess or add information.

Return exactly this format:
Answer: <answer>
Evidence: <rule number and relevant sentence, or "Not found">
"""

    response = client.chat.completions.create(
        model="qwen3.8-flash",
        messages=[
            {"role": "user", "content": prompt}
        ],
        extra_body={"enable_thinking": False}
    )

    # Qwen 응답에서 실제 답변 텍스트를 꺼내 출력한다.
    answer = response.choices[0].message.content
    print("\n" + answer)