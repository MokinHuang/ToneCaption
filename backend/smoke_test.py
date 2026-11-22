"""单独跑通模型：对指定 WAV 实际推理一次，打印原始结果与清洗正文。"""
import json
import sys

import sensevoice

path = sys.argv[1] if len(sys.argv) > 1 else "samples/asr_example_zh.wav"
print("device:", sensevoice.device())
print("input:", path)
result = sensevoice.transcribe(path)
print("=== RAW ===")
for r in result["raw"]:
    print(r)
print("=== CLEAN ===")
print(json.dumps(result, ensure_ascii=False, indent=2))