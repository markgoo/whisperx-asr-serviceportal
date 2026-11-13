"""用 FunASR 的 CT-Transformer 做中文标点恢复，和现有启发式对比。

输入：之前转写好的 4.5 分钟中文文本（已去掉标点）
输出：两版标点结果，供人工对比
"""
import json
import os
import sys
import time

RAW = os.path.join(os.environ["TEMP"], "ab-run1.json")
if not os.path.exists(RAW):
    print(f"找不到输入文件: {RAW}")
    sys.exit(1)

with open(RAW, "r", encoding="utf-8") as f:
    raw = json.load(f)

segments = raw.get("segments", [])
print(f"输入 {len(segments)} 段")

# 拼成整段无标点文本
plain = "".join(
    s["text"].replace("，", "").replace("。", "").replace("？", "").replace("！", "")
    for s in segments
)
print(f"无标点全文 {len(plain)} 字")
print()

# 关注区域：154-175 秒（用户指出的那段）
focus_start, focus_end = 154, 175
focus = "".join(
    s["text"].replace("，", "").replace("。", "").replace("？", "").replace("！", "")
    for s in segments
    if s["start"] >= focus_start and s["start"] <= focus_end
)
print("=== 待处理的重点片段（无标点）===")
print(focus)
print()

print("=== 加载 CT-Punc 模型（首次会下载约 290MB）===")
t0 = time.time()
from funasr import AutoModel

model = AutoModel(model="ct-punc", disable_update=True, device="cpu")
print(f"模型就绪，用时 {time.time() - t0:.0f}s")
print()

print("=== CT-Punc 结果：重点片段 ===")
t1 = time.time()
res = model.generate(input=focus)
elapsed = time.time() - t1
text = res[0]["text"]
print(text)
print(f"（{len(focus)} 字用了 {elapsed:.2f}s）")
print()

print("=== CT-Punc 结果：全文前 400 字 ===")
res2 = model.generate(input=plain[:800])
print(res2[0]["text"][:400])
print()

# 保存完整结果供对比
out = {
    "plain_length": len(plain),
    "focus_plain": focus,
    "focus_punc": text,
    "full_head": res2[0]["text"],
}
outfile = os.path.join(os.environ["TEMP"], "ct-punc-result.json")
with open(outfile, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(f"结果已保存: {outfile}")
