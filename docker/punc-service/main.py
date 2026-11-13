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
DEVICE = os.getenv("PUNC_DEVICE", "cpu")
MAX_CHARS = int(os.getenv("PUNC_MAX_CHARS", "4000"))

app = FastAPI(title="Punctuation Restoration Service", version="1.0.0")

_model = None


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
