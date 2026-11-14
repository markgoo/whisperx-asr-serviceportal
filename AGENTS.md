# AGENTS.md — 给接手这个项目的 AI 助手

这份文档写给**继续开发这个项目的 AI 编码助手**。假设你已经有完整工具权限，
需要快速理解这是什么、为什么这么设计、哪些坑已经踩过。人类使用说明看 `README.md`。

---

## 1. 这是什么

给 [whisperx-asr-service](https://github.com/murtaza-nasir/whisperx-asr-service) 配的
Web 门户。上游只提供裸 API（`POST /asr`），没有登录、没有任务管理、没有前端。
这个项目补上：

- 多用户账号体系（三级角色）
- 一个录音 = 一个任务，后台队列串行转写
- 说话人分离 + 说话人改名 + 按人筛选
- 播放器与转写文本联动
- 服务器端录音存储与清理

**不是** 在重写 ASR 引擎，而是给现成引擎做前端和业务层。

---

## 2. 怎么跑

```bash
cd <repo>
cp .env.docker.example .env.docker     # 填 HF_TOKEN（说话人分离必需）
docker compose --env-file .env.docker up -d
# http://127.0.0.1:8080   admin / admin123
```

三个容器（`docker-compose.yml`）：

| 服务 | 端口 | 镜像 | 作用 |
|---|---|---|---|
| `asr` | 9000 | `learnedmachine/whisperx-asr-service:latest` | 转写 + 说话人分离，需要 NVIDIA GPU |
| `punc` | 9001 | 本地 `docker/punc-service` 构建 | 中文标点恢复，CPU |
| `portal` | 8080 | 本地 `Dockerfile` 构建 | 门户本体 |

改代码后重建：

```bash
docker compose --env-file .env.docker build portal
docker compose --env-file .env.docker up -d --force-recreate portal
```

ASR 也是本地构建的（`docker/asr-service/`，官方镜像 + 一个 9 行补丁，
让 `DIARIZATION_MODEL` 能选模型）。升级 `ASR_IMAGE_TAG` 后重跑一次：

```bash
docker compose --env-file .env.docker build asr
docker compose --env-file .env.docker up -d --force-recreate asr
```

**注意**：只 `npm run build` 不会更新容器里的代码，必须 rebuild 镜像。
这个坑我踩过——改完逻辑测试没效果，查了半天才发现容器跑的是旧镜像。

---

## 3. 数据流

```
浏览器上传录音
   ↓  POST /api/tasks（multipart）
门户存盘 data/uploads/<userId>/<uuid>.ext
   ↓  写 tasks 表，status=queued
worker（src/server/worker.ts）取任务
   ↓  POST /asr（multipart，带 diarize/language/model 等 query 参数）
WhisperX 返回 segments + word_segments（词级时间戳）
   ↓
splitByPause()          按停顿、词边界重切分段 + 启发式标点
   ↓
smoothSpeakers()        合并 diarization 抖动造成的碎片段
   ↓
normalizeSegments()     合并拆开的英文/数字、术语词典、繁转简、去尾部重复
   ↓
punctuateTexts()        调 punc 服务，用 CT-Punc 重判标点（失败则保留启发式）
   ↓
写回 tasks.result_json / result_text，status=completed
```

---

## 4. 关键文件

```
src/server/
  worker.ts        任务队列、调 ASR、串起整个后处理流水线  ★ 改流水线看这里
  segmenter.ts     分段 + 标点 + 说话人平滑                ★ 最复杂的模块
  normalizer.ts    文本规范化（术语、繁简、重复截断）
  puncClient.ts    标点服务 HTTP 客户端
  asrClient.ts     调 WhisperX /asr 的 multipart 客户端
  routes.ts        所有 REST 接口
  db.ts            SQLite 建表 + 迁移 + 设置读写
  auth.ts          Cookie 会话、角色中间件
  storage.ts       文件落盘、路径校验、磁盘统计
docker/punc-service/  标点 + VAD 静音检测服务（FastAPI + FunASR）
docker/asr-service/   ASR overlay 镜像：官方镜像 + DIARIZATION_MODEL 补丁
src/client/pages/taskDetail.ts   ★ 最复杂的前端页面（播放器联动、筛选、改名）
```

---

## 5. 设计决策：为什么这么做（改之前先读）

### 5.1 标点用模型，不用提示词

**不要试图用 `initial_prompt` 或 `hotwords` 修标点和术语。** 实测会污染正文：
长句 prompt 会让转写末尾多出一段提示词原文；短关键词会让首尾循环输出这些词。
这是 whisper 的已知缺陷。

正确做法：结果侧修正。规则式（`normalizer.ts`）管术语和拼写，
模型式（`punc` 服务）管标点。

### 5.2 标点服务必须独立成容器

`funasr` 会带自己的 numpy / transformers 版本。装进 ASR 服务会打乱
whisperx 那套已 pin 好的依赖——**pyannote 曾经把 CUDA torch 换成 CPU 版，
导致 CUDA 静默失效**（`torch.cuda.is_available()` 变 False，但服务不报错）。

隔离是必须的，不是洁癖。

### 5.3 分段优先吸附到中文词边界

`segmenter.ts` 里的 `wordBoundaries()` 用 `Intl.Segmenter` 拿词边界，
所有切点和逗号位置都会 `snap()` 到最近的边界。不做这一步会出现：

- `竞争者` 切成 `竞争` / `者`
- `替代品` 切成 `替代` / `品`
- `什么` 切成 `有什` / `么`

另外 `CLING_START` 集合里的字（者/性/化/的/了/在…）不能作为断点起点。

### 5.4 词与段落严格绑定

`assignWordsToSegments()` 用游标按顺序分配词，**不要改回按时间范围过滤**。
时间过滤会让相邻段落重复吃到边界处的词，输出里会出现内容重复。

### 5.5 改名不能整页重渲染

`taskDetail.ts` 的 `applyNames()` 只重画筛选标签、转写列表、发言统计三块。
调 `renderTaskDetail()` 整页重渲染会重建 `<audio>` 元素，播放位置跳回 0:00。
已有回归测试 `tools/ui-rename-keeps-playback.js`。

### 5.6 前端静态资源不缓存

`src/server/index.ts` 里强制 `Cache-Control: no-store`。这是本地工具，
改完必须刷新即生效。之前设了 5 分钟缓存，导致改完看不到效果白排查。

---

## 6. 已经踩过的坑（不要再踩）

| 坑 | 现象 | 结论 |
|---|---|---|
| 容器里的 `127.0.0.1` | 门户连不上 punc 服务（ECONNREFUSED） | 容器内要用服务名 `http://punc:9001`，走 `PUNC_SERVICE_URL` 环境变量 |
| nltk 拒绝读挂载目录 | 词级时间戳失败 → 分段退化成不切分（50 段变 12 段） | 挂载的 Windows 目录被判为「别人可写」。nltk 数据放容器内命名卷 |
| Windows 绑定的 `.cache` | 同上（权限问题），且 SQLite WAL 也有锁问题 | 模型缓存可以挂，nltk / 数据库不要挂 Windows 目录 |
| torchcodec DLL | 启动弹「无法找到入口」对话框 | 它按更新版 torch 编译，与本项目 pinned 的版本不匹配。音频解码走 ffmpeg，卸载即可 |
| pyannote 降级 torch | CUDA 静默变 False | 装完 pyannote 必须重新 pin CUDA 版 torch |
| `condition_on_previous_text` | 以为能修重复，实际无效 | **whisperx 默认就是 False**，找不到这个开关别浪费时间 |
| 只 build 不 rebuild 镜像 | 改的代码不生效 | 容器跑的是镜像，必须 `docker compose build` + `force-recreate` |
| `docker cp` 进容器的补丁 | `--force-recreate` 后静默消失，切回默认模型还不报错 | ASR 的 `DIARIZATION_MODEL` 补丁就这么丢过。现在改走 `docker/asr-service/` overlay 镜像，补丁打在构建期 |

---

## 7. 已知未解决的问题

### 7.1 `RESEGMENT_BY_SPEAKER` 会切碎中文

whisperx 按 diarization 的说话人切换点**硬切**文本，中文没有空格，
就切在字中间，还产生重复：

```
我觉得就挺好  |  得就挺。  |  的一步，但。
怎么能保持…怎  |  幺那么多没脑
```

`RESEGMENT_BY_SPEAKER=true` 说话人准确但有碎片；
`false` 文本干净但一段内混多人。已在 `smoothSpeakers()` 做缓解
（50 段 → 31 段，碎片归零），但**字被切开无法还原**，因为合并后词级信息已丢。

要彻底解决需要拿到 diarization 的 turn 级数据自己对齐，而 `/asr` 不返回它。
可能的方向：直接调 pyannote 拿 turns，或者改上游让它返回。

### 7.2 凭空插入的人名（幻觉）

whisper 偶尔会插入与内容无关的人名，例如一段台湾政论里突然出现「郭文贵先生说」。
`normalizer.ts` 的 `truncateRepetition()` 能截掉逐字重复，
但**认不出凭空出现的名字**——它看起来像正常文本。目前只能人工纠正。

### 7.3 老任务不会自动变好

后处理逻辑改了之后，**已完成的任务不会重新处理**。
`POST /api/tasks/:id/reprocess` 只能重跑文本规范化（术语、繁简），
不能重跑分段——因为数据库没存词级时间戳。要彻底重来只能「重新转写」。

如果想解决，可以在 tasks 表加一列存 `word_segments`。

---

## 8. 代码约定

- **后端和前端都是 TypeScript**，前端编译成原生 ES module。不要引入 React/Vue——
  当前设计是零构建框架，改一行 CSS 刷新就能看到。
- 前端所有 DOM 用 `src/client/dom.ts` 的 `h()` 构造，不要用 innerHTML 拼字符串
  （文件名和转写内容来自用户输入，会 XSS）。
- 数据库迁移写在 `db.ts` 的 `migrate()` 里，用 `PRAGMA table_info` 判断列是否存在。
  不要修改已有 `SCHEMA` 里的列定义去「改」老库。
- API 错误统一抛 `HttpError`（`util.ts`），由 `index.ts` 的 error middleware 转 JSON。
- 所有「可能失败的增强功能」（标点服务、术语修正）必须能优雅降级，
  不能因为它们挂了就让转写失败。

---

## 9. 测试

```bash
# 端到端（需要服务在跑）
npm run test:e2e

# 带说话人断言（需要真人语音）
HAS_HF_TOKEN=1 SPEECH_WAV=/path/to/multi-speaker.wav npm run test:e2e

# 界面检查（无头浏览器截图）
node tools/ui-check.js

# 分段质量评估
node tools/compare-segmenter.js     # 新旧逻辑对比
node tools/eval-segmenter.js        # 指标评估
node tools/inspect-speakers.js      # 查说话人碎片
```

`tools/` 下有些脚本是当时排查用的，依赖 `%TEMP%` 里的中间文件，
不是所有都能直接跑。`smoke-test.js` 和 `ui-check.js` 是稳定的。

---

## 10. 红线

- **不要把 `.env.docker` / `.env` 提交**。里面有 HF_TOKEN。
- **不要把 `data/` 提交**。里面有用户录音和账号。
- 不要为了「看起来更准」去动 `initial_prompt` / `hotwords`（见 5.1）。
- 不要把标点服务塞回 ASR 容器（见 5.2）。
- 改 `.env.docker` 里的 `RESEGMENT_BY_SPEAKER` 时，要同步告诉用户会有取舍（见 7.1）。

---

## 11. 硬件与性能参考

实测环境：RTX 4060 Ti 16GB + `large-v3`。

| 场景 | 耗时 |
|---|---|
| 4.5 分钟中文播客（含分离） | 约 60 秒 |
| 词级对齐 | 每 10 分钟音频约 2 分钟 |
| 说话人分离 | 每 10 分钟音频约 1-2 分钟 |
| CT-Punc 标点 | 100 字约 0.1 秒（CPU） |

显存：`large-v3` 加载后约 7.8 GB。`MODEL_KEEP_ALIVE_SECONDS=600` 让模型
空闲 10 分钟后自动卸载，不用停容器就能把显存还回来。
