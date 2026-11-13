# WhisperX ASR 门户
#
# 两阶段构建：编译 TypeScript，只把产物和运行依赖带进最终镜像。
# better-sqlite3 是原生模块，必须在 Linux 里编译，不能在 Windows 上拷过去。
FROM node:22-bookworm AS builder

WORKDIR /build

# better-sqlite3 需要编译工具链（预编译包不覆盖所有 Node 版本组合时回退到源码编译）
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.server.json tsconfig.client.json ./
COPY src ./src
COPY public ./public
COPY tools/fix-esm-imports.js ./tools/fix-esm-imports.js

RUN npm run build

# 只保留生产依赖，减小最终镜像
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai

WORKDIR /app

# 运行期依赖：better-sqlite3 的 .node 是编译好的，但仍需要 libstdc++
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/public ./public
COPY package.json ./

# 数据目录：SQLite 数据库 + 上传的录音
VOLUME ["/app/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/auth/me').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
