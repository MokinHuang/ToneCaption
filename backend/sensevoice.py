"""SenseVoiceSmall 加载与结果解析。模型在进程内只加载一次并复用。"""
import os
import re
import threading

import soundfile as sf

_MODEL = None
_LOCK = threading.Lock()

EMOTIONS = {
    "NEUTRAL": "neutral",
    "HAPPY": "happy",
    "SAD": "sad",
    "ANGRY": "angry",
    "FEARFUL": "fearful",
    "DISGUSTED": "disgusted",
    "SURPRISED": "surprised",
}
LANGS = {"zh", "en", "yue", "ja", "ko", "nospeech"}
STRUCTURAL = {
    "Speech",
    "/Speech",
    "Event",
    "/Event",
    "ITN",
    "/ITN",
    "withitn",
    "woitn",
}
EVENTS = {"Laughter", "Applause", "BGM", "Cough", "Sneeze", "Cry", "Breath"}
TAG_RE = re.compile(r"<\|([^|>]*)\|>")
CJK_GAP_RE = re.compile(r"(?<=[一-鿿])\s+(?=[一-鿿])")


def device() -> str:
    import torch

    want = os.environ.get("SENSEVOICE_DEVICE", "cpu").lower()
    if want.startswith("cuda") and torch.cuda.is_available():
        return want
    return "cpu"


def get_model():
    global _MODEL
    with _LOCK:
        if _MODEL is None:
            from funasr import AutoModel

            _MODEL = AutoModel(
                model="iic/SenseVoiceSmall",
                vad_model="fsmn-vad",
                vad_kwargs={"max_single_segment_time": 20000},
                device=device(),
                disable_update=True,
            )
        return _MODEL


def clean_text(rich: str) -> str:
    text = TAG_RE.sub("", rich)
    text = CJK_GAP_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_rich(rich: str):
    emotion = None
    language = None
    events = []
    for tag in TAG_RE.findall(rich):
        if tag in EMOTIONS:
            emotion = EMOTIONS[tag]
        elif tag in LANGS:
            language = tag
        elif tag in STRUCTURAL:
            continue
        elif tag in EVENTS and tag not in events:
            events.append(tag)
    return clean_text(rich), emotion, language, events


def transcribe(path: str) -> dict:
    model = get_model()
    info = sf.info(path)
    result = model.generate(
        input=path,
        cache={},
        language="zh",
        use_itn=True,
        batch_size_s=60,
        merge_vad=True,
        merge_length_s=15,
        output_timestamp=True,
    )
    segments = []
    raw = []
    for item in result:
        rich = item.get("text", "")
        raw.append(rich)
        text, emotion, language, events = parse_rich(rich)
        if text:
            seg = {"text": text, "emotion": emotion, "events": events}
            # 字级时间戳（CTC 峰值锚点，毫秒，相对整段音频）：识别器支持时可选透传。
            # words 逐字含标点，"".join(words) 与清洗后文本一致；旧版 funasr 无此输出则省略。
            words = item.get("words")
            timestamps = item.get("timestamp")
            if (
                isinstance(words, list)
                and isinstance(timestamps, list)
                and len(words) == len(timestamps)
                and len(words) > 0
            ):
                seg["tokens"] = words
                seg["timestamps"] = [
                    [int(t[0]), int(t[1])] for t in timestamps
                ]
            segments.append(seg)
    overall_text = "".join(s["text"] for s in segments)
    overall_emotion = next((s["emotion"] for s in segments if s["emotion"]), None)
    overall_events = []
    for s in segments:
        for e in s["events"]:
            if e not in overall_events:
                overall_events.append(e)
    overall_lang = next(
        (parse_rich(r)[2] for r in raw if parse_rich(r)[2]), None
    )
    return {
        "text": overall_text,
        "emotion": overall_emotion,
        "events": overall_events,
        "language": overall_lang,
        "segments": segments,
        "raw": raw,
        "duration_s": round(info.duration, 2),
        "device": device(),
    }