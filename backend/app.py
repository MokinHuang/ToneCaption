"""最小转写后端：POST /api/transcribe 接收短 WAV，返回真实转写与情感/事件。"""
import os
import tempfile
from contextlib import asynccontextmanager

import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

import sensevoice

MAX_BYTES = 15 * 1024 * 1024
MIN_SECONDS = 0.5
MAX_SECONDS = 60.0

_state = {"ready": False, "error": None}


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        sensevoice.get_model()
        _state["ready"] = True
    except Exception as exc:  # 模型加载失败时接口给出明确原因
        _state["error"] = str(exc)
    yield


app = FastAPI(title="ToneCaption Transcribe", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {
        "status": "ok" if _state["ready"] else "loading_or_failed",
        "model_loaded": _state["ready"],
        "load_error": _state["error"],
        "device": sensevoice.device(),
    }


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)):
    if not _state["ready"]:
        raise HTTPException(
            status_code=503,
            detail=f"模型尚未就绪：{_state['error'] or '仍在加载，请稍后重试'}",
        )
    name = (file.filename or "").lower()
    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="文件为空，请选择一段 WAV 录音")
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=400, detail="文件超过 15MB，请截取 5–20 秒的片段")
    is_wav = data[:4] == b"RIFF" and data[8:12] == b"WAVE"
    if not is_wav:
        raise HTTPException(
            status_code=400,
            detail="不是有效的 WAV 文件（缺少 RIFF/WAVE 头），请上传 .wav 录音",
        )
    if not name.endswith(".wav"):
        raise HTTPException(status_code=400, detail="仅支持 .wav 格式，请转换后重试")

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    try:
        tmp.write(data)
        tmp.close()
        try:
            info = sf.info(tmp.name)
        except Exception:
            raise HTTPException(status_code=400, detail="WAV 文件损坏或编码无法读取")
        if info.duration < MIN_SECONDS:
            raise HTTPException(status_code=400, detail="录音太短（不足 0.5 秒）")
        if info.duration > MAX_SECONDS:
            raise HTTPException(
                status_code=400,
                detail=f"录音 {info.duration:.1f} 秒过长，请截取 60 秒以内（建议 5–20 秒）",
            )
        try:
            return sensevoice.transcribe(tmp.name)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"识别失败：{exc}")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass