"""让 pyannote 用不同的人数范围分离，看几个簇最合理。"""
import os
import time

import torch

AUDIO = "/tmp/task8.mp4"
MODEL = "pyannote/speaker-diarization-community-1"
TOKEN = os.getenv("HF_TOKEN")

import whisperx
from pyannote.audio import Pipeline

wav = whisperx.load_audio(AUDIO)
audio_in = {"waveform": torch.from_numpy(wav).unsqueeze(0), "sample_rate": 16000}
print(f"音频 {len(wav)/16000:.1f}s\n")

configs = [
    {"label": "自动（不限制）", "kwargs": {}},
    {"label": "2~3 人", "kwargs": {"min_speakers": 2, "max_speakers": 3}},
    {"label": "2~4 人", "kwargs": {"min_speakers": 2, "max_speakers": 4}},
    {"label": "3 人", "kwargs": {"num_speakers": 3}},
    {"label": "4 人", "kwargs": {"num_speakers": 4}},
]

for cfg in configs:
    p = Pipeline.from_pretrained(MODEL, token=TOKEN)
    p.to(torch.device("cuda"))
    p.instantiate({"segmentation": {"min_duration_off": 1.0}})

    t0 = time.time()
    out = p(audio_in, **cfg["kwargs"])
    ann = getattr(out, "exclusive_speaker_diarization", out)

    turns = sorted((s.start, s.end, spk) for s, _, spk in ann.itertracks(yield_label=True))
    durs = sorted(e - s for s, e, _ in turns)
    by_spk = {}
    for s, e, spk in turns:
        d = by_spk.setdefault(spk, [0, 0.0])
        d[0] += 1
        d[1] += e - s

    detail = "  ".join(f"{k}:{v[0]}turn/{v[1]:.0f}s" for k, v in sorted(by_spk.items()))
    print(f"{cfg['label']:<16} turn={len(turns):>3} 中位={durs[len(durs)//2]:.2f}s  [{detail}]  {time.time()-t0:.0f}s")
