# ASR 服务：官方镜像 + 本地补丁（overlay，不重建整个镜像）
#
# 上游 learnedmachine/whisperx-asr-service 把 pyannote 分离模型名写死在
# app/pipeline.py 里，我们要能通过 DIARIZATION_MODEL 换模型做对比。
# 但没必要维护一个完整 fork——补丁只有 9 行，用 overlay 镜像即可：
# 升级上游时只改 ASR_IMAGE_TAG，不动本仓库代码。
#
# 为什么重要：这个补丁以前是用 `docker cp` 塞进容器的，容器被
# `--force-recreate` 或镜像重建后会静默丢失（切回 community-1，还不报错）。
# 现在它在镜像里，重建也还在。
#
# 构建失败是故意的：补丁打不上说明上游改了 diarization 加载逻辑，
# 宁可构建红掉，也不要静默退回官方行为。

ARG ASR_IMAGE_TAG=latest
FROM learnedmachine/whisperx-asr-service:${ASR_IMAGE_TAG}

LABEL org.opencontainers.image.base.name="learnedmachine/whisperx-asr-service:${ASR_IMAGE_TAG}" \
      org.opencontainers.image.description="whisperx-asr-service + DIARIZATION_MODEL overlay"

# 上游镜像自带 git 和 python3，但没有 patch 命令，所以用 git apply
# （在非 git 目录里也能用，只按文件路径打补丁）。
COPY diarization-model.patch /tmp/diarization-model.patch

# 先清掉 CRLF：补丁打的是容器里的 LF 文件，如果构建上下文里的补丁被
# Windows 编辑器/签出弄成 CRLF，每一行上下文都对不上。.gitattributes 里
# 已经强制 eol=lf，这里是第二层保险。
RUN cd /workspace \
 && sed -i 's/\r$//' /tmp/diarization-model.patch \
 && git apply --verbose --whitespace=nowarn /tmp/diarization-model.patch \
 && rm /tmp/diarization-model.patch

# 构建期自检：补丁真的生效了才算成功。
# 上游若把这一段代码挪走，补丁会先失败；万一上下文恰好匹配到别处，
# 这里兜住，避免镜像「构建成功但功能没有」。
RUN grep -q 'os.getenv("DIARIZATION_MODEL"' /workspace/app/pipeline.py \
 || (echo 'FATAL: DIARIZATION_MODEL patch did not land in app/pipeline.py' >&2; exit 1)
