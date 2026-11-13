"""诊断：提取各 turn 的声纹 embedding，看不同说话人的距离是否可分。

如果不同人的 embedding 余弦相似度都在 0.9 以上 → 模型认为他们是同一个人，
换 separating 模型可能有帮助。如果相似度低但聚类错 → 聚类算法的问题。
"""
import os
import sys

import numpy as np
import torch

AUDIO = "/tmp/task8.mp4"
PIPELINE_MODEL = "pyannote/speaker-diarization-community-1"
TOKEN = os.getenv("HF_TOKEN")

import whisperx
from pyannote.audio import Model, Inference, Pipeline
from pyannote.core import Segment

wav = whisperx.load_audio(AUDIO)
audio_in = {"waveform": torch.from_numpy(wav).unsqueeze(0), "sample_rate": 16000}

pipeline = Pipeline.from_pretrained(PIPELINE_MODEL, token=TOKEN)
pipeline.to(torch.device("cuda"))
pipeline.instantiate({"segmentation": {"min_duration_off": 2.0}})

out = pipeline(audio_in)
ann = getattr(out, "exclusive_speaker_diarization", out)
turns = sorted(((s, spk) for s, _, spk in ann.itertracks(yield_label=True)), key=lambda x: x[0].start)

print(f"共 {len(turns)} 个 turn")

# 用独立的 embedding 模型（community-1 的 pipeline.embedding 是个 dict，不好直接用）
EMB_MODEL = os.getenv("EMB_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")
print(f"embedding 模型: {EMB_MODEL}")
emb_model = Model.from_pretrained(EMB_MODEL, token=TOKEN)
inference = Inference(emb_model, window="whole")
inference.to(torch.device("cuda"))

usable = [(seg, spk) for seg, spk in turns if seg.end - seg.start >= 1.0]
print(f"可用于分析的 turn（>=1s）: {len(usable)}")

embs = {}
for seg, spk in usable:
    try:
        e = inference.crop(audio_in, Segment(seg.start, seg.end))
        if isinstance(e, torch.Tensor):
            e = e.detach().cpu().numpy()
        e = np.asarray(e).flatten()
        if e.size == 0:
            continue
        embs.setdefault(spk, []).append(e / (np.linalg.norm(e) + 1e-9))
    except Exception as exc:
        print(f"  跳过 {seg.start:.1f}-{seg.end:.1f}: {exc}")

print("\n=== 各说话人内部一致性（同一人的不同片段之间）===")
for spk, vecs in sorted(embs.items()):
    if len(vecs) < 2:
        print(f"  {spk}: 只有 {len(vecs)} 个样本")
        continue
    sims = []
    for i in range(len(vecs)):
        for j in range(i + 1, len(vecs)):
            sims.append(float(np.dot(vecs[i], vecs[j])))
    print(f"  {spk}: {len(vecs)} 个片段, 内部相似度 均值 {np.mean(sims):.3f} 最小 {np.min(sims):.3f}")

print("\n=== 跨说话人相似度（不同人的片段之间）===")
spks = sorted(embs.keys())
for i in range(len(spks)):
    for j in range(i + 1, len(spks)):
        a, b = spks[i], spks[j]
        cross = [float(np.dot(x, y)) for x in embs[a] for y in embs[b]]
        if not cross:
            continue
        within_a = [float(np.dot(x, y)) for x in embs[a] for y in embs[a]]
        print(f"  {a} vs {b}: 跨人相似度 均值 {np.mean(cross):.3f}（内部是 {np.mean(within_a):.3f}）")

print("\n=== 判读 ===")
print("  跨人相似度 << 内部相似度 → 声纹可分，是聚类问题")
print("  跨人相似度 ≈ 内部相似度 → 模型认为声音相同，换模型可能有帮助")
