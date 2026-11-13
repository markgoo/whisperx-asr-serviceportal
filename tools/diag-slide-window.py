"""用滑窗 + cam++ 做完整 diarization，输出时间轴上的说话人切换。"""
import os
import sys
import tempfile

import numpy as np
import soundfile as sf

AUDIO = "/tmp/task8-16k.wav"
WIN = 3.0      # 窗口秒数（更长更稳定）
HOP = 1.5      # 步长
print(f"窗口 {WIN}s，步长 {HOP}s\n")

from funasr import AutoModel

data, sr = sf.read(AUDIO, dtype="float32")
if data.ndim > 1:
    data = data.mean(axis=1)
total = len(data) / sr
print(f"音频 {total:.1f}s")

print("=== 1. VAD 找语音区间 ===")
vad = AutoModel(model="fsmn-vad", device="cpu", disable_update=True)
vad_res = vad.generate(input=AUDIO)
spans = [(a / 1000, b / 1000) for a, b in vad_res[0]["value"]]
print(f"  {len(spans)} 个语音段，合计 {sum(b-a for a,b in spans):.1f}s")

print("\n=== 2. 滑窗提取 embedding ===")
sv = AutoModel(model="cam++", device="cpu", disable_update=True)
tmpdir = tempfile.mkdtemp()

wins = []   # (center, embedding)
for s, e in spans:
    t = s
    while t + WIN <= e + 0.01:
        a = int(t * sr)
        b = int(min(t + WIN, e) * sr)
        chunk = data[a:b]
        if len(chunk) < sr * 1.0:
            break
        p = os.path.join(tmpdir, f"w{int(t*100)}.wav")
        sf.write(p, chunk, sr)
        try:
            res = sv.generate(input=p)
            emb = np.asarray(res[0]["spk_embedding"]).flatten()
            if emb.size:
                wins.append((t + (b - a) / sr / 2, emb / (np.linalg.norm(emb) + 1e-9)))
        except Exception:
            pass
        t += HOP

print(f"  得到 {len(wins)} 个窗口 embedding")
if len(wins) < 10:
    sys.exit(0)

E = np.vstack([w[1] for w in wins])
centers = np.array([w[0] for w in wins])

print("\n=== 3. 聚类 ===")
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import silhouette_score

best = None
for k in range(2, 7):
    cl = AgglomerativeClustering(n_clusters=k, metric="cosine", linkage="average")
    labels = cl.fit_predict(E)
    try:
        sil = silhouette_score(E, labels, metric="cosine")
    except Exception:
        sil = -1
    sizes = np.bincount(labels)
    print(f"  {k} 簇: {list(sizes)}  轮廓系数 {sil:.3f}")
    if best is None or sil > best[2]:
        best = (k, labels, sil)

k, labels, sil = best
print(f"\n选用 {k} 簇（轮廓系数 {sil:.3f}）")

print("\n=== 4. 时间轴上的说话人切换 ===")
prev = None
for c, lab in sorted(zip(centers, labels)):
    if lab != prev:
        print(f"  {c:6.1f}s  ->  Speaker {lab}")
        prev = lab
