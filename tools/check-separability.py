"""检查一段音频的说话人能否被声纹分开。

用途：当 diarization 的结果可疑（说话人切换频繁、或者看着像一个人却在换人），
用这个判断到底是「模型分错了」还是「这段录音本来就难分」。

方法：
  1. 用 pyannote 标注的 speaker 把音频切成 turn
  2. 每个 turn 用 cam++ 提取声纹
  3. 比较组内相似度（同一人不同片段）和组间相似度（不同人）

判读：
  组间明显低于组内（差 0.2 以上）→ 确实是多个人，分离值得做
  组间接近或高于组内          → 模型看到的其实是同一个声音，
                                要么这段是独白，要么两人声纹太接近

用法（在 punc 容器里跑）：
  docker cp tools/check-separability.py whisperx-punc:/tmp/sep.py
  docker exec whisperx-punc python3 /tmp/sep.py <任务ID>
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

TASK_ID = int(sys.argv[1]) if len(sys.argv) > 1 else 9
MIN_TURN_SEC = 1.0

con = sqlite3.connect("file:/data/portal.db?mode=ro", uri=True)
row = con.execute("SELECT payload FROM task_words WHERE task_id = ?", (TASK_ID,)).fetchone()
audio_path = con.execute("SELECT storage_path FROM tasks WHERE id = ?", (TASK_ID,)).fetchone()
con.close()

if not row:
    print(f"任务 #{TASK_ID} 没有词级数据，需要先重新转写一次（词级数据是 v0.9 之后才存的）")
    sys.exit(1)

stored = json.loads(row[0])
if audio_path is None:
    print(f"任务 #{TASK_ID} 不存在")
    sys.exit(1)

audio_path = audio_path[0].replace("/app/data", "/data")
words = [w for w in stored["words"] if w.get("start") is not None and w.get("speaker")]
if not words:
    print("词级数据里没有 speaker 标签（转写时可能没开说话人分离）")
    sys.exit(1)

# 按连续 speaker 分组成 turn
turns = []
cur = None
for w in words:
    if cur is None or cur["spk"] != w["speaker"]:
        if cur:
            turns.append(cur)
        cur = {"spk": w["speaker"], "start": w["start"], "end": w["end"]}
    else:
        cur["end"] = w["end"]
if cur:
    turns.append(cur)
turns = [t for t in turns if t["end"] - t["start"] >= MIN_TURN_SEC]

by_spk = {}
for t in turns:
    by_spk.setdefault(t["spk"], []).append(t)

print(f"任务 #{TASK_ID}: {len(words)} 个带标签的词 → {len(turns)} 个 turn（>= {MIN_TURN_SEC}s）")
print("  " + ", ".join(f"{k}={len(v)}" for k, v in sorted(by_spk.items())))


def load_audio(path, sr=16000):
    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(sr), "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32), sr


data, sr = load_audio(audio_path)

from funasr import AutoModel

sv = AutoModel(model="cam++", device="cpu", disable_update=True, disable_pbar=True, log_level="ERROR")
tmp = tempfile.mkdtemp()

emb = {}
for t in turns:
    ia, ib = int(t["start"] * sr), int(t["end"] * sr)
    p = os.path.join(tmp, f"t{len(emb)}.wav")
    sf.write(p, data[ia:ib], sr)
    try:
        e = np.asarray(sv.generate(input=p)[0]["spk_embedding"]).flatten()
        if e.size:
            emb.setdefault(t["spk"], []).append(e / (np.linalg.norm(e) + 1e-9))
    except Exception:
        pass

if len(emb) < 2:
    print(f"\n只有 {len(emb)} 个 speaker 有足够样本，无法比较")
    sys.exit(0)

print("\n=== 组内一致性 ===")
centers = {}
for spk, vecs in sorted(emb.items()):
    if len(vecs) < 2:
        print(f"  {spk}: 样本太少（{len(vecs)}）")
        centers[spk] = vecs[0]
        continue
    sims = [float(np.dot(vecs[i], vecs[j])) for i in range(len(vecs)) for j in range(i + 1, len(vecs))]
    print(f"  {spk}: {len(vecs)} 个样本, 均值 {np.mean(sims):.3f}, 最小 {np.min(sims):.3f}")
    m = np.mean(vecs, axis=0)
    centers[spk] = m / np.linalg.norm(m)

print("\n=== 组间相似度 ===")
spks = sorted(centers)
worst = 1.0
for i in range(len(spks)):
    for j in range(i + 1, len(spks)):
        d = float(np.dot(centers[spks[i]], centers[spks[j]]))
        worst = min(worst, d)
        print(f"  {spks[i]} vs {spks[j]}: {d:.3f}")

print("\n=== 判读 ===")
if worst < 0.7:
    print(f"  组间最低 {worst:.3f} —— 确实是不同的声音，分离值得做")
else:
    print(f"  组间最低 {worst:.3f} —— 模型认为这些「说话人」声音相同。")
    print("  可能是独白，也可能是两人声纹太接近（低码率单声道会加剧）。")
    print("  这种情况自动化分不开，建议人工核对后改名。")
