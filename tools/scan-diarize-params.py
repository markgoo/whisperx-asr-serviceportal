"""扫描 diarization 的 segmentation 参数，看哪个能抑制碎片化。"""
import os
import sys
import time

import torch

AUDIO = "/tmp/task8.mp4"
MODEL = "pyannote/speaker-diarization-community-1"
TOKEN = os.getenv("HF_TOKEN")

import whisperx
from pyannote.audio import Pipeline

wav = whisperx.load_audio(AUDIO)
waveform = torch.from_numpy(wav).unsqueeze(0)
audio_in = {"waveform": waveform, "sample_rate": 16000}
duration = len(wav) / 16000
print(f"音频时长 {duration:.1f}s\n")

pipeline = Pipeline.from_pretrained(MODEL, token=TOKEN)
pipeline.to(torch.device("cuda"))

# 打印当前参数，确认哪些可调
params = pipeline.parameters(instantiated=True)
print("=== 默认参数 ===")
for k in sorted(params.keys()):
    v = params[k]
    if isinstance(v, (int, float, str, bool, type(None))):
        print(f"  {k} = {v}")
print()

configs = [
    {"label": "默认", "params": {}},
    {"label": "min_duration_off=1.0", "params": {"segmentation": {"min_duration_off": 1.0}}},
    {"label": "min_duration_off=2.0", "params": {"segmentation": {"min_duration_off": 2.0}}},
    {"label": "min_duration_off=3.0", "params": {"segmentation": {"min_duration_off": 3.0}}},
]

for cfg in configs:
    p = Pipeline.from_pretrained(MODEL, token=TOKEN)
    p.to(torch.device("cuda"))
    for section, values in cfg["params"].items():
        p.instantiate({section: values})

    t0 = time.time()
    out = p(audio_in)
    ann = getattr(out, "exclusive_speaker_diarization", out)

    turns = [(s.start, s.end, spk) for s, _, spk in ann.itertracks(yield_label=True)]
    turns.sort()
    durs = sorted(e - s for s, e, _ in turns)
    short = sum(1 for d in durs if d < 1)
    speakers = sorted({t[2] for t in turns})

    print(f"{cfg['label']:<26} turn={len(turns):>3}  短于1s={short:>3}  中位={durs[len(durs)//2]:.2f}s  说话人={len(speakers)}  耗时={time.time()-t0:.0f}s")
