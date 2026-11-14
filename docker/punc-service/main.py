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
from pathlib import Path
from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

MODEL_NAME = os.getenv("PUNC_MODEL", "ct-punc")
VAD_MODEL = os.getenv("VAD_MODEL", "fsmn-vad")
SV_MODEL = os.getenv("SV_MODEL", "cam++")
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


# ---------------------------------------------------------------------------
# 按人工标注分类
# ---------------------------------------------------------------------------

_sv_model = None


def get_sv_model():
    """cam++ 声纹模型。CPU 推理，一个 3 秒片段约 40ms。"""
    global _sv_model
    if _sv_model is None:
        logger.info("Loading speaker embedding model")
        from funasr import AutoModel

        _sv_model = AutoModel(model=SV_MODEL, device="cpu", disable_update=True, disable_pbar=True)
        logger.info("Speaker embedding model ready")
    return _sv_model


def _read_audio(path: str):
    """用 ffmpeg 解成 16k 单声道 float32。

    soundfile 不支持 mp4，而镜像里已经有 ffmpeg（VAD 也要用）。
    """
    import subprocess

    import numpy as np

    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-i", path, "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
        capture_output=True,
        check=True,
        timeout=600,
    ).stdout
    return np.frombuffer(out, dtype=np.float32), 16000


def _embed_range(model, audio, sr: int, start: float, end: float):
    """截一段时间提取声纹，返回归一化向量；太短或失败返回 None。

    临时文件写到固定目录、以时间戳命名，覆盖写入而不是每次删——
    容器里删文件既没必要也容易被安全策略拦。
    """
    import hashlib

    import numpy as np
    import soundfile as sf

    ia = int(max(0.0, start) * sr)
    ib = int(min(len(audio) / sr, end) * sr)
    if ib - ia < sr // 2:  # 不到 0.5 秒的片段声纹不可靠
        return None

    key = hashlib.md5(f"{start:.3f}-{end:.3f}".encode()).hexdigest()[:12]
    p = f"/tmp/sv_{key}.wav"
    try:
        sf.write(p, audio[ia:ib], sr)
        out = model.generate(input=p)
        vec = np.asarray(out[0]["spk_embedding"], dtype="float32").flatten()
        if not vec.size:
            return None
        n = np.linalg.norm(vec)
        return vec / n if n else None
    except Exception as exc:
        logger.warning(f"embedding failed for {start:.1f}-{end:.1f}: {exc}")
        return None


@app.post("/classify", response_model=ClassifyResponse)
def classify(req: ClassifyRequest):
    """用人工标注的片段算每个说话人的声纹中心，再给目标片段分类。

    相比无监督聚类，这里「有几类、每类的中心」都由人工确定，
    避开了聚类最难的部分。代价是需要先标注几个样本。
    """
    import numpy as np

    audio_path = Path(req.path)
    if not audio_path.is_file():
        raise HTTPException(404, f"文件不存在：{req.path}")

    groups: dict = {}
    for s in req.seeds:
        groups.setdefault(s.speaker, []).append((s.start, s.end))
    if len(groups) < 2:
        raise HTTPException(400, "至少需要两个说话人的标注样本")

    started = time.time()
    audio, sr = _read_audio(str(audio_path))
    model = get_sv_model()

    centers = {}
    for spk, spans in groups.items():
        vecs = [v for a, b in spans if (v := _embed_range(model, audio, sr, a, b)) is not None]
        if not vecs:
            logger.warning(f"说话人 {spk} 的标注样本太短，跳过")
            continue
        m = np.mean(np.vstack(vecs), axis=0)
        n = np.linalg.norm(m)
        centers[spk] = m / n if n else m

    if len(centers) < 2:
        raise HTTPException(400, "有效样本不足两个（标注片段太短？）")

    names = list(centers.keys())
    matrix = np.vstack([centers[k] for k in names])

    results = []
    for t in req.targets:
        vec = _embed_range(model, audio, sr, t.start, t.end)
        if vec is None:
            results.append(ClassifyResult(speaker=None, score=0.0, margin=0.0))
            continue
        sims = matrix @ vec
        order = np.argsort(-sims)
        best = int(order[0])
        second = float(sims[order[1]]) if len(order) > 1 else -1.0
        results.append(
            ClassifyResult(
                speaker=names[best],
                score=round(float(sims[best]), 4),
                margin=round(float(sims[best] - second), 4),
            )
        )

    elapsed = int((time.time() - started) * 1000)
    logger.info(
        f"Classified {len(req.targets)} span(s) against {len(centers)} speaker(s) in {elapsed}ms"
    )
    return ClassifyResponse(
        results=results,
        centers={k: {"count": len(groups.get(k, []))} for k in names},
        elapsedMs=elapsed,
    )
