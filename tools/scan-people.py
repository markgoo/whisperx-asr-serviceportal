"""扫描不同说话人数，输出每个人的发言时长分布，找出最合理的配置。"""
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
    ("自动", {}),
    ("3 人", {"num_speakers": 3}),
    ("4 人", {"num_speakers": 4}),
    ("5 人", {"num_speakers": 5}),
    ("6 人", {"num_speakers": 6}),
    ("3~6 人", {"min_speakers": 3, "max_speakers": 6}),
]

for label, kwargs in configs:
    p = Pipeline.from_pretrained(MODEL, token=TOKEN)
    p.to(torch.device("cuda"))
    p.instantiate({"segmentation": {"min_duration_off": 2.0}})

    t0 = time.time()
    out = p(audio_in, **kwargs)
    ann = getattr(out, "exclusive_speaker_diarization", out)

    turns = sorted((s.start, s.end, spk) for s, _, spk in ann.itertracks(yield_label=True))
    by_spk = {}
    for s, e, spk in turns:
        d = by_spk.setdefault(spk, {"n": 0, "dur": 0.0})
        d["n"] += 1
        d["dur"] += e - s

    total = sum(v["dur"] for v in by_spk.values())
    print(f"### {label}（{len(by_spk)} 个说话人，{len(turns)} turn，{time.time()-t0:.0f}s）")
    for spk, v in sorted(by_spk.items(), key=lambda x: -x[1]["dur"]):
        pct = v["dur"] / total * 100
        bar = "█" * int(pct / 4)
        print(f"  {spk}: {v['dur']:6.1f}s ({pct:4.1f}%) {v['n']:3d}turn  {bar}")
    print()
