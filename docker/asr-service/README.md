# ASR overlay 镜像

官方镜像 `learnedmachine/whisperx-asr-service:latest` 上的**增量补丁层**，
不重建整个镜像（whisperx / pyannote / torch 的版本都是上游 pin 好的，
自己装一遍等于重走 pyannote 降级 torch 那个坑）。

当前只打一个补丁：`diarization-model.patch`
→ 让 `DIARIZATION_MODEL` 环境变量能选 pyannote 模型，
默认仍是 `pyannote/speaker-diarization-community-1`，可切 `pyannote/speaker-diarization-3.1`。

产物镜像：`whisperx-asr:<ASR_IMAGE_TAG>`（compose 里构建并引用）。

## 历史：为什么不再用 `docker cp`

`HANDOFF-speaker-diarization.md` §3.2 里这个补丁是 `docker cp` 塞进容器的。
问题是：

- 容器 `--force-recreate` 或镜像重建 → 补丁**静默消失**，切回默认模型
- 不报错、日志里只是少了那行 `Loading diarization pipeline: <name>`
- 排查时会误判成「换模型没效果」

现在补丁在镜像里，上面这些都不成立。

## 升级上游

```bash
# 1. 改 ASR_IMAGE_TAG（.env.docker 或默认值）
# 2. 重新构建。补丁打不上会直接失败，不会静默降级
docker compose --env-file .env.docker build asr
docker compose --env-file .env.docker up -d --force-recreate asr
# 3. 确认日志里是期望的模型名
docker logs whisperx-asr --tail 30 | grep "Loading diarization pipeline"
```

## 补丁失效了怎么重做

```bash
# 取出新基础镜像里的原文件（必须是 LF 换行）
docker run --rm --entrypoint cat learnedmachine/whisperx-asr-service:latest \
  /workspace/app/pipeline.py > /tmp/pipeline-orig.py

# 改出你想要的效果，存成 /tmp/pipeline-new.py（也是 LF）
# 然后重新生成补丁
mkdir -p /tmp/ptest/a/app /tmp/ptest/b/app
cp /tmp/pipeline-orig.py /tmp/ptest/a/app/pipeline.py
cp /tmp/pipeline-new.py  /tmp/ptest/b/app/pipeline.py
cd /tmp/ptest && diff -u a/app/pipeline.py b/app/pipeline.py \
  > /path/to/docker/asr-service/diarization-model.patch
```

注意：**不要在 Windows 上用编辑器直接改容器里的 py 文件再 diff**，
Git Bash / 编辑器会写成 CRLF，`git apply` 会整文件不匹配。

两层保护：

- `.gitattributes` 给本目录的 patch / Dockerfile 强制了 `eol=lf`
  （Windows 上 `core.autocrlf=true` 时签出会变成 CRLF）
- Dockerfile 里 `sed -i 's/\r$//'` 在 `git apply` 前清一遍，已实测：
  故意放 CRLF 补丁也能打上
