# 待处理问题：说话人分离归属错误

**状态**：切分逻辑已优化到极限，但 speaker 归属本身不准，卡在这里。
**交接日期**：2026-11-13
**仓库**：
- 门户 `C:\AI\whisperx-asr-serviceportal`（https://github.com/markgoo/whisperx-asr-serviceportal）@ `16368cb`
- ASR `C:\AI\whisperx-asr-service`（https://github.com/markgoo/whisperx-asr-service）@ `136628c`

---

## 1. 问题现象

2 分 46 秒的户外采访录音（村民讲一棵树的故事，记者提问）。
**段落切分本身是对的，但说话人标签归属错了。**

任务 #8 / #9 的实际输出：

```
[   0.0] SPEAKER_01  每年都有的菩萨生日都会来搞活动，都是在这棵树下，那为什么选在这？
[   8.1] SPEAKER_01  棵树呢选在这棵树吗？这棵嘛我。
[  21.6] （空标签）   也不打清楚，反正我爷爷那时候说。
[  22.0] SPEAKER_00  它是那个里面嘛，有个洞嘛，洞里面有那个菩萨的嘛，它是被雷后来打掉的嘛哦。
[  24.4] SPEAKER_01  最中间的。
[  33.5] SPEAKER_01  那颗已经被打掉了是吧？这颗只剩下一层皮了…
[  55.7] SPEAKER_00  因为它太高了，以前布区里面是布的，有个布舍的…
```

肉眼可判断的错误：

1. `[0.0]` 和 `[8.1]` 是**记者**的提问（「那为什么选在这？」「选在这棵树吗？」），
   却被标成 `SPEAKER_01`——而 `SPEAKER_01` 在 `[24.4]`、`[33.5]` 说的明显是村民的内容。
2. `[22.0]` 和 `[55.7]` 的村民陈述被标成 `SPEAKER_00`，但 `[0.0]` 的记者提问也是
   `SPEAKER_01`，前后矛盾。
3. `[21.6]` 段落**没有说话人标签**（界面上显示空白）。

---

## 2. 已经确认的事实（不要去重查）

### 2.1 词级 speaker 是有的

whisperx 的 `assign_word_speakers()` 已经给每个词打了标签，
`/asr` 的 `word_segments` 里就带着：

```json
{"word":"今","start":0.031,"end":0.852,"score":0.936,"speaker":"SPEAKER_02"}
```

1303 个词里 1300 个有标签，只有 3 个是 null（落在 diarization 区间之外）。

**结论：不需要改 ASR 服务来暴露更多数据。**

### 2.2 切分逻辑已经优化到极限

门户已改为按词级 speaker 分组（`groupWordsBySpeaker` + `smoothTurns`，
在 `src/server/segmenter.ts`），细节：

- 按 `word.speaker` 变化分组，切点天然落在词与词之间，不会切碎中文词
- `smoothTurns()` 消除换人瞬间抖动：
  - A→B→A 夹心：把中间那个小轮次并回两侧（按词数 + 时长判断）
  - 首尾碎边：开头/结尾的短轮次并进相邻段
- 结果：22 段 → 15 段，碎片（<1.5 秒）从 3 个降到 **0**

**结论：碎片问题已解决，剩下的错误是「整段归属错」，不是切分问题。**

### 2.3 调人数参数没用

同一段音频对比过：

| 设置 | 词数分布 |
|---|---|
| 自动判断 | `SPEAKER_00=340  SPEAKER_01=465` |
| `num_speakers=2` | `SPEAKER_00=340  SPEAKER_01=465`（**完全一致**） |
| `num_speakers=3` | `SPEAKER_00=305  SPEAKER_01=429  SPEAKER_02=71`（只拆出一小块，主要归属没变） |

**结论：pyannote 的聚类结果稳定，参数调不动。**

### 2.4 分离参数：一个有效，三个无效（2026-11-13 补测）

直接调 pyannote（绕过 whisperx 封装）扫描 segmentation 参数，
发现 **`min_duration_off` 确实有效**：

| `min_duration_off` | turn 数 | 短于 1 秒 | 中位时长 |
|---|---|---|---|
| 0（默认） | 100 | 46 | 1.06s |
| 1.0 | 52 | 20 | 1.74s |
| **2.0** | **30** | **9** | **3.95s** |
| 3.0 | 19 | 5 | 3.95s |

诊断时的原始 turn 数据（默认参数）：

```
共 100 个 turn
turn 时长: 最短 0.02s  中位 1.06s  最长 9.32s
短于 1 秒的 turn: 46 个

[2.75-3.03]  0.29s  SPEAKER_00
[3.03-3.14]  0.10s  SPEAKER_01   ← 0.1 秒的 turn
[3.14-3.54]  0.40s  SPEAKER_00
```

**结论：pyannote 的 segmentation 在这段音频上严重碎片化**（100 个 turn，46 个不到 1 秒）。
`min_duration_off=2.0` 能压到 30 个，已设为默认（`.env.docker`）。

但参数只解决「切得碎」，**不解决「归属错」**。

其他参数仍无效：

| 参数 | 值 | 结果 |
|---|---|---|
| `DIARIZE_CLUSTERING_THRESHOLD` | 0.5 / 0.9 | 结果**完全一样**（343/462），参数对这段音频不敏感 |
| `num_speakers` | 2 | 和自动判断完全一致 |
| `num_speakers` | 3 / 4 | 只是把簇切细，主要归属没变 |

### 2.5 音频本身的硬伤

```
codec_name=aac
channels=1          ← 单声道
sample_rate=48000
bit_rate=47990      ← 只有 48 kbps
```

**单声道 + 48kbps 低码率**（从视频抽的音轨）。声纹特征（区分说话人的依据）
在强压缩下损失严重，这可能是碎片化和归属错误的共同根因。

这也解释了为什么降噪无效——信息已经在大压缩中丢了，滤波找不回来。

### 2.6 降噪预处理反而更差

用 ffmpeg 做了 `highpass=f=120,afftdn=nf=-25,dynaudnorm=f=200` 处理后重转：

| | 段落数 | 说话人切换 |
|---|---|---|
| 原始音频 | 17 段 | 记者提问和村民陈述仍混 |
| 降噪后 | **22 段** | **更碎**，还引入了新幻觉（「对对对对对对对」连续 13 个） |

**结论：不是简单的背景噪音问题**。过度降噪把语音弄失真后，
ASR 反而产生新的重复幻觉。

---

## 2.7 当前状态

已做：
- 切分逻辑优化到极限（碎片 0、标签无空白、切点落在词边界）
- `min_duration_off=2.0` 抑制 segmentation 碎片化（turn 100 → 30）
- 三个无效方向都验证过并排除

仍未解决：**说话人归属错误**。表现是同一个人的连续发言被标成两个人，
或者记者的提问和村民的回答被并进同一段。

最可能的原因：**单声道 + 48kbps 低码率**导致声纹区分度不足。



---

## 3. 正在做、但被打断的两件事

### 3.1 空 speaker 标签补全（代码已改，未验证）

**文件**：`src/server/segmenter.ts` → `groupWordsBySpeaker()`

**改动**：null 标签的词继承前一个非空标签；开头就为空的，用后面第一个非空标签。

**未验证**：改完后 `npm run build` + 重建容器 + 重新转写任务 #9，
需要确认 `[21.6]` 那行不再显示空白。

```bash
cd C:\AI\whisperx-asr-serviceportal
npx tsc -p tsconfig.server.json
docker compose --env-file .env.docker build portal
docker compose --env-file .env.docker up -d --force-recreate portal
# 然后 POST /api/tasks/9/retry（需先登录）
```

### 3.2 换 pyannote 模型对比（环境已配好，未跑完）

**当前默认**：`pyannote/speaker-diarization-community-1`
**想对比**：`pyannote/speaker-diarization-3.1`

代码改动（`C:\AI\whisperx-asr-service\app\pipeline.py` 第 ~757 行）：
已经支持 `DIARIZATION_MODEL` 环境变量，`docker-compose.yml` 和第 `.env.docker` 也已加。

**⚠️ 重要**：ASR 用的是官方镜像
`learnedmachine/whisperx-asr-service:latest`，`app/pipeline.py` 的改动是通过
`docker cp app\pipeline.py whisperx-asr:/workspace/app/pipeline.py` 塞进容器的，
**容器被 `--force-recreate` 或镜像重建后会丢失**。

> **2026-11-14 已解决**：不再用 `docker cp`。补丁固化进了 overlay 镜像
> `docker/asr-service/`（compose 里 `asr` 改成 build，产物 `whisperx-asr:latest`），
> 构建期 `git apply` 打补丁，打不上就构建失败。已实测：`--force-recreate`
> 后补丁仍在，且 `DIARIZATION_MODEL` 真的会被读取（填个不存在的模型会抛
> `RepositoryNotFoundError`）。详见 `docker/asr-service/README.md`。

**验证命令**：

```bash
# 切到 3.1
# .env.docker 里设 DIARIZATION_MODEL=pyannote/speaker-diarization-3.1
docker compose --env-file .env.docker up -d --force-recreate asr
# 确认日志里加载的是哪个模型
docker logs whisperx-asr --tail 30 | grep "Loading diarization pipeline"
```

---

## 4. 怀疑方向（按可能性排序）

### 4.1 音频质量（最可能）

- 户外采访，背景风声/环境噪声重
- 记者和村民可能**共用一支话筒**，音色被混
- 词级时间戳也异常：实测单个词「我」被给了 **5.45 秒**的时长，
  说明这段音频的对齐质量本身就不高

**建议**：先拿这段音频做降噪/人声分离再转写，看 diarization 是否变准。
如果确认是音质问题，就不用再折腾参数了。

### 4.2 pyannote 调参

代码里已有 `_apply_diarize_tuning(pipeline)`，pipeline.py 支持：

- `DIARIZE_MIN_DURATION_OFF`（多短的停顿才算换人，调大能减少误切）
- `VAD_ONSET` / `VAD_OFFSET` / `VAD_METHOD`（pyannote | silero）
- `DIARIZE_FILL_NEAREST`

这些**都还没针对这段音频试过**，是下一步最省力的方向。
特别是 `min_duration_off`，它直接控制「短暂停顿是否触发换人」。

### 4.3 换更强的模型

- `pyannote/speaker-diarization-3.1`（更早但稳定）
- NVIDIA NeMo 的 diarization
- 阿里 FunASR 的说话人分离（和已接入的 CT-Punc 同一个生态）

### 4.4 接受现状 + 人工修正

界面已支持「说话人改名」和「按人筛选」，切分又准确到词，
人工把标错的人名改过来是可行的。如果音频质量确实是瓶颈，这是最实际的方案。

---

## 5. 环境与复现

### 服务

```bash
cd C:\AI\whisperx-asr-serviceportal
docker compose --env-file .env.docker up -d
# portal  :8080  admin/admin123
# asr     :9000  GPU
# punc    :9001  标点服务
```

### 测试音频

任务 #8/#9 的原始音频已导出到 `%TEMP%\task8.mp4`（35.9 MB）。
如果没了，从容器里取：

```bash
docker cp whisperx-portal:/app/data/uploads/1/<uuid>.mp4 %TEMP%\task8.mp4
```

路径查法：

```bash
docker exec -w /app whisperx-portal node -e "const D=require('better-sqlite3');const db=new D('/app/data/portal.db',{readonly:true});console.log(db.prepare('SELECT storage_path FROM tasks WHERE id=8').get());db.close();"
```

### 直接调 ASR 做实验（不经过门户）

```powershell
$Body = @{ audio_file = Get-Item "$env:TEMP\task8.mp4" }
$uri = "http://127.0.0.1:9000/asr?task=transcribe&model=large-v3&output_format=json&diarize=true&language=zh&word_timestamps=true&num_speakers=2"
$r = Invoke-WebRequest -Uri $uri -Method POST -Form $Body -TimeoutSec 900 -UseBasicParsing
$r.Content | Set-Content "$env:TEMP\result.json" -Encoding UTF8
```

### 分析词级 speaker 分布

```bash
docker exec -w /app whisperx-portal node -e "const D=require('better-sqlite3');const db=new D('/app/data/portal.db',{readonly:true});const s=JSON.parse(db.prepare('SELECT result_json FROM tasks WHERE id=9').get().result_json);for(const x of s.slice(0,10))console.log(x.start.toFixed(1),x.speaker||'(空)',x.text.slice(0,40));db.close();"
```

---

## 6. 未提交的改动

**门户** `C:\AI\whisperx-asr-serviceportal`：
- `src/server/segmenter.ts` — 空 speaker 标签补全（3.1 节，未验证）
- `docker-compose.yml` — 加了 `DIARIZATION_MODEL` 环境变量
- `tools/check-empty-speaker.js` — 临时排查脚本

**ASR** `C:\AI\whisperx-asr-service`：
- `app/pipeline.py` — 支持 `DIARIZATION_MODEL` 环境变量
- `tools/dsh-*.{bat,ps1}` — 与本次问题无关，是别的工具，可以忽略

---

## 7. 给接手方的建议顺序

1. **先验证 3.1 节**（空标签补全），5 分钟，确认那个空白行修好了
2. **试 `DIARIZE_MIN_DURATION_OFF`**（4.2 节），最省力的调参方向，
   重点看记者/村民的交替边界是否变准
3. **如果参数无效**，做一次降噪预处理对比（4.1 节），确认是不是音频质量问题
4. **如果确认是音质问题**，就别再折腾了，用人工改名（4.4 节）

不建议一上来就换模型或重写分离逻辑——已经验证过参数和切分都不是瓶颈。
