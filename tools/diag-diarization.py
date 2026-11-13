"""直接跑 pyannote，输出原始 diarization 结果，用于诊断。

不经过 whisperx 的 assign_word_speakers，看模型本身给出的 turn 是什么样。
"""
import os
import sys
import time

import torch

AUDIO = sys.argv[1] if len(sys.argv) > 1 else "/tmp/task8.mp4"
MODEL = sys.argv[2] if len(sys.argv) > 2 else "pyannote/speaker-diarization-community-1"
TOKEN = os.getenv("HF_TOKEN")

print(f"音频: {AUDIO}")
print(f"模型: {MODEL}")
print()

t0 = time.time()
from pyannote.audio import Pipeline

pipeline = Pipeline.from_pretrained(MODEL, token=TOKEN)
pipeline.to(torch.device("cuda"))
print(f"模型加载 {time.time() - t0:.1f}s")

# pyannote 4.x 需要 torchcodec 读文件，这里改用 waveform dict 绕过
import whisperx
t1 = time.time()
wav = whisperx.load_audio(AUDIO)
waveform = torch.from_numpy(wav).unsqueeze(0)
output = pipeline({"waveform": waveform, "sample_rate": 16000})
print(f"分离耗时 {time.time() - t1:.1f}s")

# pyannote 4.x 返回 DiarizeOutput，取实际的 Annotation
if hasattr(output, "exclusive_speaker_diarization"):
    ann = output.exclusive_speaker_diarization
    print("（使用 exclusive_speaker_diarization）")
elif hasattr(output, "speaker_diarization"):
    ann = output.speaker_diarization
else:
    ann = output

turns = []
for segment, _, speaker in ann.itertracks(yield_label=True):
    turns.append({"start": segment.start, "end": segment.end, "speaker": speaker})

turns.sort(key=lambda x: x["start"])
print(f"\n共 {len(turns)} 个 turn")
speakers = {}
for t in turns:
    d = t["end"] - t["start"]
    s = speakers.setdefault(t["speaker"], {"n": 0, "dur": 0.0})
    s["n"] += 1
    s["dur"] += d

print("\n各说话人统计:")
for spk, s in sorted(speakers.items()):
    print(f"  {spk}: {s['n']} 个 turn, 合计 {s['dur']:.1f}s")

durs = sorted((t["end"] - t["start"]) for t in turns)
print(f"\nturn 时长: 最短 {durs[0]:.2f}s  中位 {durs[len(durs)//2]:.2f}s  最长 {durs[-1]:.2f}s")
print(f"短于 1 秒的 turn: {sum(1 for d in durs if d < 1)} 个")

print("\n前 30 个 turn:")
for t in turns[:30]:
    print(f"  [{t['start']:6.2f}-{t['end']:6.2f}] {t['end']-t['start']:5.2f}s  {t['speaker']}")
