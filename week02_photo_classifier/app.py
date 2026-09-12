# 운영체제의 환경변수를 읽기 위한 기본 모듈
import os

# .env 파일의 값을 환경변수로 불러오는 함수
from dotenv import load_dotenv

# OpenAI 호환 방식으로 Qwen API를 호출하는 클래스
from openai import OpenAI

# 현재 폴더의 .env 파일을 읽는다.
load_dotenv()

# .env에 저장한 API Key와 Endpoint로 Qwen 클라이언트를 만든다.
client = OpenAI(
    api_key=os.getenv("sk-ws-H.DDYRYDP.JjNL.MEUCIFGUkv-NkM9YkihD1gm0P2YgG2A1iak7xj7eFpOOJH5OAiEAx4Lo0aIwP0QSJSlhrqt4kyC6i4wbEUXXfXTDZ7PJ2Xc"),
    base_url=os.getenv("https://ws-8her56jddi6nf65j.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1")
)

# qwen3.8-flash 모델에 짧은 테스트 메시지를 보낸다.
response = client.chat.completions.create(
    model="qwen3.8-flash",
    messages=[
        {
            "role": "user",
            "content": "Say API connection successful."
        }
    ],
    # 추론 과정 없이 최종 답변만 받는다.
    extra_body={"enable_thinking": False}
)

# Qwen이 보낸 답변 내용을 터미널에 출력한다.
print(response.choices[0].message.content)