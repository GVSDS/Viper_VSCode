from openai import OpenAI

# 指向本地Ollama服务，不是OpenAI官网
client = OpenAI(
    base_url="http://127.0.0.1:11434/v1",
    api_key="dummy"  # 本地模式key无校验，随便填写占位字符串
)

resp = client.chat.completions.create(
    model="qwen3.5:4b",
    messages=[
        {"role":"user","content":"你好"}
    ],
    max_tokens=1024,
    temperature=0.7
)

print(resp.choices[0].message.content)