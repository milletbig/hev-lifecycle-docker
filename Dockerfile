# 混动车全生命周期记录 —— 运行镜像
# 零 npm 依赖：仅使用 Node.js 内置模块，构建过程无需访问 npm registry。
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    PUBLIC_DIR=/app/public \
    DATA_DIR=/data

LABEL org.opencontainers.image.title="hev-lifecycle" \
      org.opencontainers.image.description="混动车全生命周期记录（带登录鉴权与服务端持久化）" \
      org.opencontainers.image.version="1.0.2"

# 专用非 root 账号，避免与宿主机既有 uid 冲突
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app

WORKDIR /app

COPY server/ ./server/
COPY app/ ./public/

RUN mkdir -p /data/backups \
    && chown -R app:app /app /data \
    && chmod 700 /data /data/backups \
    && chmod 600 /app/server/server.js

USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=8s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
