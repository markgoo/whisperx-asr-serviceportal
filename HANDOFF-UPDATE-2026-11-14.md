# 进展说明：2026-11-13 晚 → 11-14

**给接手的 AI**：这份文档接着 `HANDOFF-speaker-diarization.md` 写，
只覆盖那份文档之后发生的事。先读那份了解问题的来龙去脉，再读这份看进展。

**仓库**：`C:\AI\whisperx-asr-serviceportal`（https://github.com/markgoo/whisperx-asr-serviceportal）
**分支**：`main` @ `f77a1bd`

---

## 0. 一句话总结

昨晚的结论是「说话人分离调不动，可能是音频质量问题」。**今天推翻了**——
找到了 4 个真正的 bug，其中 2 个是我自己引入的。现在分段和说话人边界都对了，
但「两个人紧接说话、中间没停顿」的情况仍然分不干净。

---

## 1. 这期间的提交（按时间顺序）

| 提交 | 内容 |
|---|---|
| `766de50` | 补全缺失的说话人标签，消除空白说话人段落 |
| `80077d6` | 补全调参实验结果（记录无效的方向） |
| `1aec090` | 手机端布局修复（与分离问题无关） |
| `a291402` | **用 VAD 真实静音分段**（关键修复） |
| `f77a1bd` | **短句换人被当成抖动抹平**（关键修复） |

---

## 2. 关键的技术发现（对后来者最有价值）

### 2.1 whisperx 的词级时间戳不可靠

它会把**真实停顿算进标点符号的时长**：

```
 9.34-  9.36 ( 0.02s)  呢
 9.36- 15.51 ( 6.15s)  ?      ← 一个问号占了 6.15 秒
 8.12-  9.32 ( 1.20s)  棵     ← 一个「棵」字占了 1.2 秒（其实是拖长音，不是停顿）
```

**后果**：按「字时长超出预期 = 停顿」去切分，会把「这棵树」切成「这棵|树」。

**`Intl.Segmenter` 救不了**：它把中文切成单字，「棵|树」在它看来就是合法词边界。

**正确做法**：用 VAD 看音频能量（实现见 3.1）。VAD 给出的数据对比：

| 词级误判 | VAD 实测 |
|---|---|
| 「棵」1.20 秒 | 8.61-8.94 只有 **0.33 秒** |
| 「?」6.15 秒 | 那里其实有语音，不是静音 |
| — | 21.45-23.59 **2.14 秒**（真停顿） |

### 2.2 `pauseSec` 参数从没生效过

`segmenter.ts` 的 `SplitOptions.pauseSec`（默认 0.85 秒）定义了但**从未被使用**。
所有停顿只用来加逗号，分段只在「超过 22 秒或 60 字」时才发生。

后果：一段 24 秒里含三次说话人切换也不会切开。

### 2.3 说话人分离的「调参」是死路

`HANDOFF` 文档里记了 `num_speakers` 和 `clustering_threshold` 无效。今天补测了
`min_duration_off` 和降噪，结论：

| 尝试 | 结果 |
|---|---|
| `DIARIZE_MIN_DURATION_OFF=0.3` | 343/462（基线 340/465，几乎无变化） |
| `DIARIZE_CLUSTERING_THRESHOLD=0.5` | 343/462 |
| `DIARIZE_CLUSTERING_THRESHOLD=0.9` | 343/462（和 0.5 **完全一样**） |
| 降噪（highpass+afftdn+dynaudnorm） | **更差**：17→22 段，引入「对对对对对对对」连续 13 个 |

**唯一有效的参数**是 `DIARIZE_MIN_DURATION_OFF`，但它只减少碎片
（turn 100→30），不改变归属。

### 2.4 声纹本身是可分的（推翻「音频质量不行」的结论）

用 FunASR 的 cam++ 提取段落级 embedding（11 秒/段）：

```
相似度分布: 均值 0.539  最小 0.127  最大 0.909
<0.60 的对: 51/78
```

**不同段之间的相似度只有 0.127**，说明声纹信息是够的，pyannote 没能利用好。

但**做不成稳定的时间轴分配**：
- 滑窗 1.5 秒 → 轮廓系数 0.171，切换 30+ 次（太碎）
- 滑窗 3 秒 → 轮廓系数 0.254，切换 13 次，但仍跨边界混淆

原因是「固定窗口」这个方法本身：窗口小 embedding 不稳，窗口大跨说话人边界。

### 2.5 标点符号会把真实停顿「吸收」掉

这是 2.1 的另一面。把标点合并回前一个词（`把「呢」+「?」变成「呢?」`）后，
停顿才算在词边界上。代码在 `splitByPause` 里的 `PUNCT_ONLY` 那段。

---

## 3. 做了什么修改

### 3.1 VAD 静音分段（`a291402`，最重要的修复）

**punc 服务**（`docker/punc-service/main.py`）加了 `/vad` 接口：
- 用 FunASR 的 `fsmn-vad`
- 接受**文件路径**而不是上传文件——compose 里把门户的 `data` 卷只读挂在 punc 的 `/data`，省掉传上百 MB 音频
- 返回 `{speech: [[s,e],...], gaps: [[s,e],...]}`

**门户侧**：
- `puncClient.ts` 加 `detectSilence()`
- `worker.ts` 转写前先调它，只取 **>= 0.5 秒**的静音当切分依据（更短的是说话自然断句）
- `splitByPause()` 加第 4 个参数 `silence?: Array<[number,number]>`，有就优先用它
- VAD 不可用时自动退回按词时长估算（不影响转写）

**Dockerfile**：ffmpeg 加在 **punc 服务**里（`docker/punc-service/Dockerfile`），
不是门户——VAD 在 punc 容器里跑，它通过只读卷 `/data` 读门户的音频。

### 3.2 短句换人不再被抹平（`f77a1bd`）

`smoothSpeakers()` 有一条「A→B→A 夹心」规则：夹在两个同一说话人之间的短段
一律当抖动，说话人改回上一个。

**但记者的追问「树下。那为什么选在这」是 0.6 秒、9 个字**，正好落在判定里，
于是被抹平。它是带句号问号的完整句子，不是抖动。

**修法**：中间段含 `。！？?!` 时不视为抖动。

---

## 4. 当前效果

任务 #9（2 分 46 秒采访，一男一女对话）的实际输出：

```
[ 0.0- 7.5] SPEAKER_01  每年都有的菩萨生日都会来搞活动，都是在这棵。   ← 村民
[ 7.5- 8.1] SPEAKER_00  树下，那为什么选在这？                     ← 记者
[ 8.1-18.0] SPEAKER_01  棵树呢选在这棵。
[18.0-22.0] SPEAKER_01  树吗？这棵嘛我也不打清楚，反正我爷爷那时候说它。
[22.0-22.6] SPEAKER_00  是那个里面嘛有个洞嘛...
```

**改善**：
- 记者的提问能被单独分出来了（之前被归给村民）
- 「都是在这棵树下」在段内完整（之前切成「这棵|树」）
- 段落按真实停顿切分，碎片 0

---

## 5. 还没解决的问题

### 5.1 停顿落在词中间

```
[ 8.1-18.0] 棵树呢选在这棵。
[18.0-22.0] 树吗？...
```

VAD 检测到说话人在「棵」和「树」之间**真的停了 0.65 秒**。停顿本身在词中间，
切开后文本必然是「选在这棵」「树吗」。**任何分段方法都改变不了**。

### 5.2 两人紧接说话、中间无停顿

如果两个人说话没有间隙（VAD 测不到静音），只能靠 diarization 的声纹判断。
而 pyannote 在这种地方会抖动（词级 speaker 每 1-2 个字跳一次）。

目前的缓解：`smoothSpeakers` 会消除抖动，但也会误伤真实短句（3.2 修的就是这个）。
**没有根治**。

### 5.3 老任务不会自动应用新逻辑

后处理改了之后，已完成的任务需要点「重新转写」才能生效。
`reprocess` 只重跑文本规范化，不重跑分段——因为数据库没存词级时间戳。

---

## 6. 下一步建议（按性价比排序）

1. **先确认是否还要继续投入**。现在的效果对「人工核对 + 改名」已经够用：
   边界准确、碎片为零、改名功能可用。

2. **如果一定要自动化**，方向是「用 cam++ 的 embedding + pyannote 的 turn 切分」：
   - pyannote 切 turn（细，30 个）
   - cam++ 提取每个 turn 的 embedding（区分度好，0.127~0.909）
   - sklearn 重新聚类
   
   今天只验证了「声纹可分」，没做完整实现。相关脚本在 `tools/` 下：
   `diag-campplus.py`、`diag-slide-window.py`、`export-turns.py`、`verify-campplus-attrib.py`

3. **不建议**继续调 pyannote 参数（已证明无效）或做降噪（会更差）。

---

## 7. 环境

```bash
cd C:\AI\whisperx-asr-serviceportal
docker compose --env-file .env.docker up -d
# portal :8080  admin/admin123  （密码可能被改过，见下）
# asr    :9000  GPU
# punc   :9001  标点 + VAD（CPU）
```

**注意**：门户的 admin 密码可能不是 `admin123`（用户改过）。需要测试账号时，
用 `tools/tmp-account.js create` 临时建一个，测完 `remove`。

**VAD 调试**：

```powershell
$body = @{ path = '/data/uploads/1/<uuid>.mp4' } | ConvertTo-Json
Invoke-WebRequest -Uri 'http://127.0.0.1:9001/vad' -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing
```

路径换算：门户存的是宿主机路径（容器内 `/app/data/...`），
punc 挂在 `/data/...`，所以 `/app/data/uploads/x.mp4` → `/data/uploads/x.mp4`。

---

## 8. 顺带完成的其他事

`1aec090` 手机端布局（与分离问题无关，但如果要改前端要知道）：

- 任务详情页标题区原来是 `flex:1 + min-width:0`，手机上被压成竖排（每个字一行）
- 所有表格在手机上只有第一列可见，改成卡片式（给每列加 `data-label`，720px 以下转换）
- toast 移到手机底部，不再挡按钮
- 概览/存储的统计卡片手机端改 2x2

回归工具：`tools/mobile-all.js`（390×844 视口跑七个页面，报告横向溢出）。

---

## 9. 2026-11-14 补记：ASR 补丁已固化进镜像

这份文档 §3.2 留下的 `docker cp` 隐患（补丁随 `--force-recreate` 静默丢失）已解决：

- 新增 `docker/asr-service/`：官方镜像 + `diarization-model.patch`（9 行，
  让 `DIARIZATION_MODEL` 生效）。构建期 `git apply`，打不上就构建失败。
- `docker-compose.yml` 里 `asr` 从 `image:` 改成 `build:`，产物 `whisperx-asr:latest`。
- 验证：`--force-recreate` 后容器里补丁仍在；把 `DIARIZATION_MODEL` 设成不存在的
  模型会抛 `RepositoryNotFoundError`，证明确实读了这个环境变量。
- 顺带补全了 `.env.docker.example` 里漏掉的分离相关变量
  （`RESEGMENT_BY_SPEAKER`、`DIARIZATION_MODEL`、`DIARIZE_*`、`ASR_CACHE_DIR`）。

下一步（本文件 §6 的建议仍然有效）：`DIARIZATION_MODEL=pyannote/speaker-diarization-3.1`
现在可以一次切换就对比，不需要再 `docker cp`。
