"""用 cam++ 的时间轴 + whisper 的词级时间戳，验证说话人归属是否正确。"""
import json
import os
import sys
import tempfile

import numpy as np
import soundfile as sf

AUDIO = "/tmp/task8-16k.wav"
WHISPER_JSON = "/tmp/whisper_words.json"   # 含 word_segments 的 ASR 结果

WIN, HOP = 3.0, 1.5

from funasr import AutoModel

# ---- 1. whisper 词 ----
raw = json.load(open(WHISPER_JSON, encoding="utf-8"))
words = [w for w in raw.get("word_segments", []) if w.get("start") is not None]
print(f"whisper 词数 {len(words)}")

# ---- 2. cam++ 滑窗 embedding ----
data, sr = sf.read(AUDIO, dtype="float32")
if data.ndim > 1:
    data = data.mean(axis=1)

vad = AutoModel(model="fsmn-vad", device="cpu", disable_update=True)
spans = [(a / 1000, b / 1000) for a, b in vad.generate(input=AUDIO)[0]["value"]]

sv = AutoModel(model="cam++", device="cpu", disable_update=True)
tmp = tempfile.mkdtemp()
centers, vecs, ranges = [], [], []

for s, e in spans:
    t = s
    while t + WIN <= e + 0.01:
        a, b = int(t * sr), int(min(t + WIN, e) * sr)
        if b - a < sr:
            break
        p = os.path.join(tmp, f"w{int(t*100)}.wav")
        sf.write(p, data[a:b], sr)
        try:
            emb = np.asarray(sv.generate(input=p)[0]["spk_embedding"]).flatten()
            if emb.size:
                vecs.append(emb / (np.linalg.norm(emb) + 1e-9))
                centers.append((t, min(t + WIN, e)))
        except Exception:
            pass
        t += HOP

print(f"cam++ 窗口 {len(vecs)} 个")

E = np.vstack(vecs)
from sklearn.cluster import AgglomerativeClustering
labels = AgglomerativeClustering(n_clusters=2, metric="cosine", linkage="average").fit_predict(E)
print(f"聚类: {list(np.bincount(labels))}")

# ---- 3. 给每个词分配 speaker（找覆盖它的窗口投票）----
def speaker_at(t):
    votes = {}
    for (ws, we), lab in zip(centers, labels):
        if ws - 0.3 <= t <= we + 0.3:
            votes[lab] = votes.get(lab, 0) + 1
    if not votes:
        return None
    return max(votes, key=votes.get)

for w in words:
    w["campplus_speaker"] = speaker_at((w["start"] + w["end"]) / 2)

# ---- 4. 按词重建段落 ----
segs, cur = [], None
for w in words:
    spk = w["campplus_speaker"]
    if cur is None or cur["spk"] != spk:
        if cur:
            segs.append(cur)
        cur = {"spk": spk, "start": w["start"], "end": w["end"], "text": w["word"]}
    else:
        cur["text"] += w["word"]
        cur["end"] = w["end"]
if cur:
    segs.append(cur)

# 合并过短的
merged = []
for s in segs:
    if merged and s["end"] - s["start"] < 1.5:
        merged[-1]["text"] += s["text"]
        merged[-1]["end"] = s["end"]
    else:
        merged.append(s)

print(f"\n段落 {len(merged)} 个\n")
print("=== 按 cam++ 分配的结果 ===")
for s in merged:
    print(f"[{s['start']:6.1f}s] Speaker {s['spk']}  {s['text'][:52]}")
