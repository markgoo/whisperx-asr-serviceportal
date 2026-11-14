"""中文标点恢复服务 —— 基于 FunASR 的 CT-Transformer。

为什么单独起一个服务：
  funasr 会拉自己的 numpy/transformers 版本，装进 ASR 服务会打乱
  whisperx 那套已 pin 好的依赖（pyannote 曾把 CUDA torch 换成 CPU 版，
  导致 CUDA 静默失效）。放进独立容器彻底隔离。

接口：
  GET  /health          -> {"status":"ok","model":"...","device":"cpu"}
  POST /punc            -> {"texts":["无标点1","无标点2"]}
                           {"texts":["带标点1","带标点2"],"elapsedMs":12}

设计取舍：
  - CT-Punc 是纯文本模型，不产出时间戳，所以由调用方负责分段，
    这里只负责把「某一段文字」的标点补对。
  - 单段太短时上下文不足，模型容易不加句号；调用方应尽量传 20 字以上的片段。
"""

import logging
import os
import time
from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

MODEL_NAME = os.getenv("PUNC_MODEL", "ct-punc")
VAD_MODEL = os.getenv("VAD_MODEL", "fsmn-vad")
DEVICE = os.getenv("PUNC_DEVICE", "cpu")
MAX_CHARS = int(os.getenv("PUNC_MAX_CHARS", "4000"))

app = FastAPI(title="Punctuation Restoration Service", version="1.0.0")

_model = None
_vad_model = None


def get_model():
    """懒加载：容器启动即可用，第一次请求才载入模型。"""
    global _model
    if _model is None:
        logger.info(f"Loading punctuation model: {MODEL_NAME} on {DEVICE}")
        from funasr import AutoModel

        _model = AutoModel(model=MODEL_NAME, device=DEVICE, disable_update=True)
        logger.info("Punctuation model ready")
    return _model


class PuncRequest(BaseModel):
    texts: List[str] = Field(..., description="无标点文本列表", max_length=200)


class PuncResponse(BaseModel):
    texts: List[str]
    elapsedMs: int


class VadRequest(BaseModel):
    path: str = Field(..., description="音频文件路径（服务端可读）")


class VadResponse(BaseModel):
    """语音段和它们之间的静音间隔。

    speech: [[start_sec, end_sec], ...]
    gaps:   [[start_sec, end_sec], ...]  相邻语音段之间的静音
    """
    speech: List[List[float]]
    gaps: List[List[float]]
    elapsedMs: int


class SeedSpan(BaseModel):
    """一段人工标注：这段时间是某个人在说。"""
    start: float
    end: float
    speaker: str


class TargetSpan(BaseModel):
    """待分类的时间段。"""
    start: float
    end: float


class ClassifyRequest(BaseModel):
    path: str = Field(..., description="音频文件路径（服务端可读）")
    seeds: List[SeedSpan] = Field(..., description="人工标注的样本，用来算每个说话人的声纹中心")
    targets: List[TargetSpan] = Field(..., description="需要判断归属的时间段")


class ClassifyResult(BaseModel):
    speaker: str | None
    score: float
    margin: float


class ClassifyResponse(BaseModel):
    """按人工标注做最近邻分类。

    每个 target 返回最像的说话人、相似度、以及和次优的差距（margin）。
    margin 小说明两个人都像，结果不可靠——调用方可以用它决定要不要提示用户确认。
    """
    results: List[ClassifyResult]
    centers: dict
    elapsedMs: int


@app.on_event("startup")
def preload():
    """启动时就加载模型。

    懒加载会让「容器刚起来」的第一次请求多等 30-60 秒，
    调用方容易直接超时。预热一次，health 通过即代表可服务。
    """
    try:
        get_model()
    except Exception as exc:
        logger.error(f"Model preload failed, will retry on first request: {exc}")


@app.post("/vad", response_model=VadResponse)
def vad(req: VadRequest):
    """用 fsmn-vad 找出语音段，返回段之间的静音间隔。

    为什么需要这个：whisperx 的词级时间戳会把「字被拖长」和「真实停顿」
    混在一起（实测一个「棵」字可以是 1.2 秒、一个「?」可以是 6.15 秒），
    从时间戳反推停顿会误判。VAD 看的是音频能量，不受这个影响。

    只接受服务端能读到的路径，不接收上传的文件——调用方（门户）和本服务
    共享同一个 data 卷，传路径省掉一次大文件传输。
    """
    from pathlib import Path

    audio_path = Path(req.path)
    if not audio_path.is_file():
        raise HTTPException(404, f"文件不存在：{req.path}")

    started = time.time()
    model = get_vad_model()
    try:
        res = model.generate(input=str(audio_path))
    except Exception as exc:
        raise HTTPException(500, f"VAD 失败：{exc}") from exc

    raw_spans = res[0].get("value") or []
    speech = [[round(a / 1000, 3), round(b / 1000, 3)] for a, b in raw_spans]
    speech.sort(key=lambda x: x[0])

    gaps: List[List[float]] = []
    for i in range(1, len(speech)):
        prev_end = speech[i - 1][1]
        cur_start = speech[i][0]
        if cur_start > prev_end:
            gaps.append([round(prev_end, 3), round(cur_start, 3)])

    elapsed = int((time.time() - started) * 1000)
    logger.info(f"VAD: {len(speech)} 个语音段, {len(gaps)} 个静音间隔, {elapsed}ms")
    return VadResponse(speech=speech, gaps=gaps, elapsedMs=elapsed)


def get_vad_model():
    global _vad_model
    if _vad_model is None:
        logger.info("Loading VAD model")
        from funasr import AutoModel

        _vad_model = AutoModel(model=VAD_MODEL, device="cpu", disable_update=True)
        logger.info("VAD model ready")
    return _vad_model


@app.get("/health")
def health():
    loaded = _model is not None
    return {"status": "ok", "model": MODEL_NAME, "device": DEVICE, "loaded": loaded}


@app.post("/punc", response_model=PuncResponse)
def punc(req: PuncRequest):
    if not req.texts:
        return PuncResponse(texts=[], elapsedMs=0)

    for i, t in enumerate(req.texts):
        if len(t) > MAX_CHARS:
            raise HTTPException(413, f"第 {i} 段过长（{len(t)} 字，上限 {MAX_CHARS}）")

    started = time.time()
    model = get_model()

    results: List[str] = []
    for text in req.texts:
        # 空文本和纯空白直接透传，避免模型返回奇怪内容
        if not text.strip():
            results.append(text)
            continue
        try:
            out = model.generate(input=text)
            results.append(out[0]["text"] if out else text)
        except Exception as exc:  # 单段失败不能拖垮整批
            logger.warning(f"Punctuation failed for one segment: {exc}")
            results.append(text)

    elapsed = int((time.time() - started) * 1000)
    logger.info(f"Punctuated {len(req.texts)} segment(s) in {elapsed}ms")
    return PuncResponse(texts=results, elapsedMs=elapsed)
