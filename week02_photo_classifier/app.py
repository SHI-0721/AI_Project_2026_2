import os
import base64
import shutil
from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

client = OpenAI(
    api_key=os.getenv("DASHSCOPE_API_KEY"),
    base_url=os.getenv("DASHSCOPE_BASE_URL")
)

LABELS = ["person", "document", "food", "device", "other"]
INPUT_DIR = Path("input")
OUTPUT_DIR = Path("sorted")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

def classify_image(image_path):
    image_base64 = base64.b64encode(image_path.read_bytes()).decode("utf-8")
    suffix = image_path.suffix.lower()
    mime_type = "image/png" if suffix == ".png" else "image/jpeg"

    prompt = f"""
Classify this photo for an automatic photo organization service.
Choose exactly one category from: {', '.join(LABELS)}
Return only the category name.
"""

    response = client.chat.completions.create(
        model="qwen3.8-flash",
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{mime_type};base64,{image_base64}"
                    }
                },
                {"type": "text", "text": prompt}
            ]
        }],
        extra_body={"enable_thinking": False}
    )

    category = response.choices[0].message.content.strip().lower()
    return category if category in LABELS else "other"

image_files = [
    path for path in INPUT_DIR.iterdir()
    if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
]

for image_path in image_files:
    category = classify_image(image_path)
    category_dir = OUTPUT_DIR / category
    category_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(image_path, category_dir / image_path.name)
    print(f"{image_path.name} → {category}")