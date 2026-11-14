# 中文标点恢复服务
#
# 只做一件事：把无标点中文文本补上「，。？」
# 用 FunASR 的 CT-Transformer，CPU 推理，单次约 0.1s / 100 字。
FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    MODELSCOPE_CACHE=/models

WORKDIR /app

# funasr 运行时要解码音频（即使这里只做文本标点），保持 libsndfile 可用。
# ffmpeg 是 /vad 接口必需的：fsmn-vad 要解码 mp3/mp4。
RUN apt-get update && apt-get install -y --no-install-recommends \
      libsndfile1 \
      build-essential \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# CPU 版 torch 单独装，避免默认源拉 CUDA 版（几个 GB 的浪费）
# torchaudio 也是必需的：funasr.utils.load_utils 会 import 它
RUN pip install --upgrade pip && \
    pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY main.py .

# 模型缓存到挂载卷，重建镜像不用重新下载
VOLUME ["/models"]

EXPOSE 9001

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9001/health', timeout=5).status==200 else 1)"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9001"]
