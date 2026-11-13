"""导出 pyannote 的 turn 时间戳，供 cam++ 重新聚类用。"""
import json
import os

import torch

import whisperx
from pyannote.audio import Pipeline

AUDIO = "/tmp/task8.mp4"
OUT = "/tmp/turns.json"

p = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-community-1", token=os.getenv("HF_TOKEN")
)
p.to(torch.device("cuda"))
p.instantiate({"segmentation": {"min_duration_off": 2.0}})

wav = whisperx.load_audio(AUDIO)
out = p({"waveform": torch.from_numpy(wav).unsqueeze(0), "sample_rate": 16000})
ann = getattr(out, "exclusive_speaker_diarization", out)

turns = [
    {"start": round(s.start, 3), "end": round(s.end, 3), "spk": spk}
    for s, _, spk in ann.itertracks(yield_label=True)
]
turns.sort(key=lambda x: x["start"])
json.dump(turns, open(OUT, "w"))

print(f"导出 {len(turns)} 个 turn 到 {OUT}")
for t in turns[:10]:
    print(f"  {t['start']:7.2f} - {t['end']:7.2f}  {t['spk']}")
print(f"  时长分布: 最短 {min(t['end']-t['start'] for t in turns):.2f}s  最长 {max(t['end']-t['start'] for t in turns):.2f}s")
