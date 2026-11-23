"""「听见重音」对照样例生成（仅开发验收用，不进生产）。

流程：edge-tts 合成自然朗读 → 本地 funasr 字级时间戳定位目标词区域 →
对目标词测量窗做 增益×2(+6dB) 生成重读变体；
平读变体把每个字测量窗的响度拉齐（不动基频，避免识别丢字）。
全部重采样为 16kHz PCM16 WAV，再逐个过更新后的 sensevoice.transcribe
拿真实 tokens/timestamps——对齐一律以变体音频自身的识别结果为准。

注意：这是 TTS+信号处理的合成对照，验证算法链路，不代表真人重音韵律。
"""
import asyncio
import json
import os
import re
import sys

import edge_tts
import librosa
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "backend"))
import sensevoice  # noqa: E402

OUT = os.path.join(ROOT, ".planning", "2026-11-22-hear-stress", "audio")
SR = 16000
VOICE = "zh-CN-XiaoxiaoNeural"
XF = int(0.015 * SR)
WORD_CHAR = re.compile(r"[一-鿿A-Za-z0-9]")

SENTENCES = {
    "A": {"text": "周五交初稿。", "words": {"zhouwu": (0, 1), "chugao": (3, 4)}},
    "B": {"text": "明天带纸质版。", "words": {"mingtian": (0, 1), "zhizhiban": (3, 5)}},
}


def crosscat(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    if len(a) == 0:
        return b
    if len(b) == 0:
        return a
    n = min(XF, len(a), len(b))
    t = np.linspace(0, 1, n)
    mid = a[-n:] * np.cos(t * np.pi / 2) + b[:n] * np.sin(t * np.pi / 2)
    return np.concatenate([a[:-n], mid, b[n:]])


def word_peaks(seg: dict) -> list:
    """逐字峰值时刻（ms）；标点字符也占位，保持与文本索引一致。"""
    peaks = []
    for tok, (s, e) in zip(seg["tokens"], seg["timestamps"]):
        peaks.append((tok, (s + e) / 2))
    return peaks


def char_windows(y: np.ndarray, peaks: list) -> list:
    """与前端检测器同一口径：锚点中点窗，句尾字右缘延到真实语音结束。
    CTC 锚点偏早且滞后不定，编辑区域直接对准测量窗，保证对照的响度差
    落在被测量的区域上（合成对照的已知局限，真人录音另测）。"""
    word_idx = [k for k, (tok, _) in enumerate(peaks) if WORD_CHAR.search(tok)]
    wp = [peaks[k][1] for k in word_idx]
    gaps = np.diff(wp)
    med_gap = float(np.median(gaps)) if len(gaps) else 200.0
    hop = int(0.025 * SR)
    win = int(0.040 * SR)
    n = max(0, (len(y) - win) // hop + 1)
    rms = np.array([np.sqrt(np.mean(y[i * hop : i * hop + win] ** 2)) for i in range(n)])
    times = (np.arange(n) * hop + win / 2) / SR * 1000
    act = np.where(rms >= max(0.008, 0.1 * float(np.max(rms))))[0]
    voiced_end = float(times[act[-1]]) + 20 if len(act) else wp[-1] + med_gap / 2
    wins = []
    for i, p in enumerate(wp):
        left = (p + wp[i - 1]) / 2 if i > 0 else max(0.0, p - med_gap / 2)
        right = voiced_end if i == len(wp) - 1 else (p + wp[i + 1]) / 2
        wins.append((left, right))
    return wins


def region_bounds(y: np.ndarray, peaks: list, i: int, j: int) -> tuple:
    wins = char_windows(y, peaks)
    return int(wins[i][0] / 1000 * SR), int(wins[j][1] / 1000 * SR)


def stress_variant(y: np.ndarray, L: int, R: int) -> np.ndarray:
    """重读 = 更响(+6dB)。纯增益不改波形形状与时长，识别锚点保持稳定，
    编辑区与检测器测量窗一致。音高/拉长证据由合成单元测试覆盖。"""
    region = y[L:R] * 2.0
    return crosscat(crosscat(y[:L], region), y[R:])


def flat_variant(y: np.ndarray, peaks: list) -> np.ndarray:
    """平读近似：只把各字测量窗的响度拉齐，不动基频（强行拉平音高会丢字）。"""
    wins = char_windows(y, peaks)
    bounds = [(int(L / 1000 * SR), int(R / 1000 * SR)) for L, R in wins]
    rmss = [float(np.sqrt(np.mean(y[L:R] ** 2))) for L, R in bounds]
    target_rms = float(np.median([r for r in rmss if r > 0]))
    out = np.array([], dtype=np.float32)
    cursor = 0
    for (L, R), rms in zip(bounds, rmss):
        out = crosscat(out, y[cursor:L])
        r = y[L:R]
        cur = float(np.sqrt(np.mean(r**2)))
        if cur > 0 and rms > 0:
            r = r * (target_rms / cur)
        out = crosscat(out, r)
        cursor = R
    out = crosscat(out, y[cursor:])
    return out


async def synth_base(key: str, text: str) -> np.ndarray:
    mp3 = os.path.join(OUT, f"{key}_base.mp3")
    await edge_tts.Communicate(text, VOICE).save(mp3)
    data, sr = sf.read(mp3, dtype="float32")
    os.unlink(mp3)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != SR:
        data = librosa.resample(data, orig_sr=sr, target_sr=SR)
    return data


def save_wav(name: str, y: np.ndarray):
    # 整体压到 0.45 峰值：重读区 ×2 后仍 ≤0.9，避免削波导致识别改字
    peak = float(np.max(np.abs(y))) if len(y) else 0
    if peak > 0:
        y = y * (0.45 / peak)
    sf.write(os.path.join(OUT, name), y, SR, subtype="PCM_16")


async def main():
    os.makedirs(OUT, exist_ok=True)
    clips = {}
    for key, spec in SENTENCES.items():
        y = await synth_base(key, spec["text"])
        natural = f"{key}_natural.wav"
        save_wav(natural, y)
        tr = sensevoice.transcribe(os.path.join(OUT, natural))
        seg = tr["segments"][0]
        peaks = word_peaks(seg)
        dur_ms = len(y) / SR * 1000
        clips[natural] = {"sentence": key, "variant": "natural", "target": None}
        flat = flat_variant(y, peaks)
        fname = f"{key}_flat.wav"
        save_wav(fname, flat)
        clips[fname] = {"sentence": key, "variant": "flat", "target": None}
        for wname, (i, j) in spec["words"].items():
            fname = f"{key}_stress_{wname}.wav"
            # 迭代对齐：编辑区按变体自身识别锚点的测量窗重定位（增益不改时长，
            # 锚点稳定后收敛），确保 +6dB 落在检测器实际测量的区域上
            cur_peaks = peaks
            for it in range(3):
                L, R = region_bounds(y, cur_peaks, i, j)
                print(f"{fname}: iter{it} L={L} R={R} ({L/SR*1000:.0f}-{R/SR*1000:.0f}ms)")
                save_wav(fname, stress_variant(y, L, R))
                trv = sensevoice.transcribe(os.path.join(OUT, fname))
                sv = trv["segments"][0]
                if sv["text"] != seg["text"]:
                    print(f"{fname}: iter{it} text changed {sv['text']!r}, keep last")
                    break
                new_peaks = word_peaks(sv)
                if new_peaks == cur_peaks:
                    break
                cur_peaks = new_peaks
            clips[fname] = {
                "sentence": key,
                "variant": f"stress_{wname}",
                "target": spec["text"][i : j + 1],
                "targetRange": [i, j + 1],
            }
        print(f"{key} base done: {dur_ms:.0f}ms, tokens={seg['tokens']}")

    transcripts = {}
    for fname in clips:
        tr = sensevoice.transcribe(os.path.join(OUT, fname))
        transcripts[fname] = {
            "text": tr["text"],
            "emotion": tr["emotion"],
            "segments": [
                {k: s[k] for k in ("text", "emotion", "tokens", "timestamps") if k in s}
                for s in tr["segments"]
            ],
        }
        has_ts = all("tokens" in s for s in tr["segments"])
        print(f"{fname}: text={tr['text']!r} timestamps={'yes' if has_ts else 'NO'}")

    with open(os.path.join(OUT, "transcripts.json"), "w", encoding="utf-8") as f:
        json.dump(transcripts, f, ensure_ascii=False, indent=1)
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(clips, f, ensure_ascii=False, indent=1)
    print("saved transcripts.json / meta.json")


asyncio.run(main())