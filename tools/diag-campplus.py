"""用 FunASR cam++ 验证声纹可分性（手动切音频片段，避免 API 参数失效）。"""
import os
import sys
import tempfile

import numpy as np
import soundfile as sf

AUDIO = sys.argv[1] if len(sys.argv) > 1 else "/tmp/task8-16k.wav"
print(f"音频: {AUDIO}")

from funasr import AutoModel

print("\n=== 1. VAD 切分语音段 ===")
vad = AutoModel(model="fsmn-vad", device="cpu", disable_update=True)
vad_res = vad.generate(input=AUDIO)
segments = vad_res[0]["value"]
usable = [(a, b) for a, b in segments if (b - a) >= 1200]
print(f"VAD 检测 {len(segments)} 段，取 >=1.2s 的 {len(usable)} 段")

# 读音频
data, sr = sf.read(AUDIO, dtype="float32")
if data.ndim > 1:
    data = data.mean(axis=1)
print(f"音频 {len(data)/sr:.1f}s @ {sr}Hz")

print("\n=== 2. 逐段提取 cam++ embedding ===")
sv = AutoModel(model="cam++", device="cpu", disable_update=True)

embs, times = [], []
tmpdir = tempfile.mkdtemp()
for i, (start_ms, end_ms) in enumerate(usable):
    a = int(start_ms / 1000 * sr)
    b = int(end_ms / 1000 * sr)
    chunk = data[a:b]
    if len(chunk) < sr * 0.5:
        continue
    p = os.path.join(tmpdir, f"seg{i}.wav")
    sf.write(p, chunk, sr)
    try:
        res = sv.generate(input=p)
        e = np.asarray(res[0]["spk_embedding"]).flatten()
        if e.size == 0:
            continue
        embs.append(e / (np.linalg.norm(e) + 1e-9))
        times.append((start_ms / 1000, end_ms / 1000))
    except Exception as exc:
        print(f"  段 {i} 失败: {str(exc)[:70]}")

print(f"成功 {len(embs)} 个 embedding，维度 {embs[0].shape if embs else 'N/A'}")
if len(embs) < 4:
    sys.exit(0)

E = np.vstack(embs)
n = len(E)
sim = E @ E.T
off = sim[~np.eye(n, dtype=bool)]

print("\n=== 3. 相似度分布 ===")
print(f"  均值 {off.mean():.3f}  最小 {off.min():.3f}  最大 {off.max():.3f}")
print(f"  >0.85 的对: {(off > 0.85).sum() // 2}/{n*(n-1)//2}")
print(f"  <0.60 的对: {(off < 0.60).sum() // 2}/{n*(n-1)//2}")

print("\n=== 4. 聚类 ===")
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import silhouette_score

for k in range(2, 6):
    cl = AgglomerativeClustering(n_clusters=k, metric="cosine", linkage="average")
    labels = cl.fit_predict(E)
    try:
        sil = silhouette_score(E, labels, metric="cosine")
    except Exception:
        sil = float("nan")
    print(f"  {k} 簇: {list(np.bincount(labels))}  轮廓系数 {sil:.3f}")

print("\n=== 5. 最不相似的几对（看是不是不同人）===")
pairs = [(i, j, sim[i, j]) for i in range(n) for j in range(i + 1, n)]
pairs.sort(key=lambda x: x[2])
for i, j, s in pairs[:5]:
    print(f"  {times[i][0]:6.1f}s vs {times[j][0]:6.1f}s : {s:.3f}")
