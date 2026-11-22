"""生成两段内容不同的中文测试录音（edge-tts 合成 → WAV）。"""
import asyncio
import os

import edge_tts
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "samples")

CLIPS = {
    "classroom_a.wav": "大家觉得哪天合适？这周五交？有冲突的同学今天下课前告诉我。",
    "classroom_b.wav": "请同学们翻开课本第三十二页，今天我们学习光的折射。注意看黑板上的这幅图。",
}
VOICE = "zh-CN-XiaoxiaoNeural"


async def main():
    os.makedirs(OUT, exist_ok=True)
    for name, text in CLIPS.items():
        mp3 = os.path.join(OUT, name.replace(".wav", ".mp3"))
        await edge_tts.Communicate(text, VOICE).save(mp3)
        data, sr = sf.read(mp3, dtype="int16")
        wav = os.path.join(OUT, name)
        sf.write(wav, data, sr, subtype="PCM_16")
        os.unlink(mp3)
        info = sf.info(wav)
        print(f"{name}: {info.duration:.2f}s {info.samplerate}Hz -> {text}")


asyncio.run(main())