"""探测识别器 output_timestamp 的真实返回：tokens/时间戳/单位/与文本对应关系。"""
import json
import sys

import sensevoice

paths = sys.argv[1:] or ["samples/asr_example_zh.wav"]
m = sensevoice.get_model()
out = []
for p in paths:
    res = m.generate(
        input=p, cache={}, language="zh", use_itn=True,
        batch_size_s=60, merge_vad=True, merge_length_s=15,
        output_timestamp=True, disable_pbar=True,
    )
    for item in res:
        text, emotion, language, events = sensevoice.parse_rich(item.get("text", ""))
        words = item.get("words")
        ts = item.get("timestamp")
        joined = "".join(words) if words else None
        out.append({
            "path": p,
            "keys": sorted(item.keys()),
            "text": text,
            "words": words,
            "timestamp": ts,
            "words_joined_eq_text": joined == text,
            "words_joined_eq_text_nospace": joined == text.replace(" ", "") if joined else None,
            "n_words": len(words) if words else 0,
            "n_ts": len(ts) if ts else 0,
            "widths_ms": [b - a for a, b in ts] if ts else None,
        })
with open("../logs/ts_probe.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print("written ../logs/ts_probe.json")