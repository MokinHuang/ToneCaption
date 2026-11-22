"""生成验收音频到 public/test-audio（UTF-8 源码，避免管道编码问题）。

s1–s3：第三阶段前半的三句验收话术。
t1–t6：语气提示验收（第三阶段后半）。
t5.wav 为**合成模拟**：对 t4「这周五交」末 360ms 做逐块递增音高上移（librosa），
模拟"像在等人确认"的读法；只用于验证检测器与管线，不代表真人韵律。
"""
import asyncio
import os

import edge_tts
import librosa
import numpy as np
import soundfile as sf

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "test-audio")
CLIPS = {
    "s1.wav": "今天讲二叉树。",
    "s2.wav": "实验报告改到下周一交。",
    "s3.wav": "第三题不用做。",
    "t1.wav": "大家觉得哪天合适？",
    "t2.wav": "改到下周一交，大家能接受吗？",
    "t3.wav": "他刚才问的是‘可以吗’，我们接着往下讲。",
    "t4.wav": "这周五交。",
    "t6.wav": "我们接着往下讲。",
}
VOICE = "zh-CN-XiaoxiaoNeural"


async def synth_clips():
    os.makedirs(OUT, exist_ok=True)
    for name, text in CLIPS.items():
        mp3 = os.path.join(OUT, name.replace(".wav", ".mp3"))
        await edge_tts.Communicate(text, VOICE).save(mp3)
        data, sr = sf.read(mp3, dtype="int16")
        wav = os.path.join(OUT, name)
        sf.write(wav, data, sr, subtype="PCM_16")
        os.unlink(mp3)
        info = sf.info(wav)
        print(f"{name}: {info.duration:.2f}s {info.samplerate}Hz")


def make_rising(src="t4.wav", dst="t5.wav", tail_ms=360, blocks=6, max_steps=4.2):
    """末段逐块递增 pitch shift + 重叠相加淡化，近似句末跨音节上扬（合成模拟）。"""
    y, sr = sf.read(os.path.join(OUT, src), dtype="float32")
    _, idx = librosa.effects.trim(y, top_db=30)
    end = int(idx[1])
    tail = int(tail_ms / 1000 * sr)
    start = max(0, end - tail)
    seg = y[start:end]
    n = len(seg) // blocks
    xf = int(0.01 * sr)
    spacing = n - xf
    buf = np.zeros((blocks - 1) * spacing + n, dtype=np.float32)
    for i in range(blocks):
        a, b = i * n, (i + 1) * n if i < blocks - 1 else len(seg)
        piece = librosa.effects.pitch_shift(seg[a:b], sr=sr, n_steps=max_steps * (i + 1) / blocks)
        w = np.ones(len(piece), dtype=np.float32)
        if i > 0:
            w[:xf] = np.linspace(0, 1, xf)
        if i < blocks - 1:
            w[-xf:] = np.linspace(1, 0, xf)
        off = i * spacing
        buf[off : off + len(piece)] += piece * w
    target = end - start
    if len(buf) != target:
        buf = librosa.effects.time_stretch(buf, rate=len(buf) / target)
    out = y.copy()
    out[start:end] = buf[:target]
    h = int(0.04 * sr)
    fade = np.linspace(0, 1, h, dtype=np.float32)
    out[start : start + h] = y[start : start + h] * (1 - fade) + out[start : start + h] * fade
    sf.write(os.path.join(OUT, dst), out, sr, subtype="PCM_16")
    print(f"{dst}: 合成模拟上扬（末{tail_ms}ms 递增至 +{max_steps} 半音）{len(out)/sr:.2f}s")


async def main():
    await synth_clips()
    make_rising()


asyncio.run(main())