#!/usr/bin/env bash
# 一键部署：校验依赖 -> 首次设置登录口令（仅保存散列）-> 初始化目录 -> 构建并启动容器
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BASE_DIR"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy][错误] %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "未找到 docker"
docker compose version >/dev/null 2>&1 || die "未找到 docker compose 插件"
command -v python3 >/dev/null 2>&1 || die "未找到 python3（用于生成口令散列）"

[ -f .env ] || cp .env.example .env

HAS_HASH="$(grep -E '^ADMIN_PASSWORD_HASH=scrypt:' .env || true)"
HAS_PLAIN="$(grep -E '^ADMIN_PASSWORD=.+$' .env || true)"

if [ -z "$HAS_HASH" ] && [ -z "$HAS_PLAIN" ]; then
    log "首次部署，需要设置登录口令（仅保存 scrypt 散列，不保存明文）"
    CURRENT_USER="$(grep -E '^ADMIN_USERNAME=' .env | cut -d= -f2)"
    read -r -p "管理员账号 [${CURRENT_USER:-admin}]: " ADMIN_USER
    ADMIN_USER="${ADMIN_USER:-${CURRENT_USER:-admin}}"
    while :; do
        read -r -s -p "登录密码（至少 10 位）: " PWD1; echo
        if [ "${#PWD1}" -ge 10 ]; then break; fi
        echo "密码长度不足 10 位，请重新输入"
    done
    read -r -s -p "再次输入密码: " PWD2; echo
    [ "$PWD1" = "$PWD2" ] || die "两次输入的密码不一致"

    HASH="$(printf '%s' "$PWD1" | python3 scripts/gen-password-hash.py)"
    unset PWD1 PWD2

    ADMIN_USER="$ADMIN_USER" HASH="$HASH" python3 - <<'PY'
import os, re
user = os.environ['ADMIN_USER']
h = os.environ['HASH']
path = '.env'
text = open(path, encoding='utf-8').read()
text = re.sub(r'(?m)^ADMIN_USERNAME=.*$', 'ADMIN_USERNAME=' + user, text)
text = re.sub(r'(?m)^ADMIN_PASSWORD_HASH=.*$', 'ADMIN_PASSWORD_HASH=' + h, text)
open(path, 'w', encoding='utf-8').write(text)
os.chmod(path, 0o600)
PY
    unset HASH
    log "口令散列已写入 .env（明文不落盘）"
fi

bash scripts/init-host.sh

log "开始构建镜像并启动容器…"
docker compose up -d --build

log "等待健康检查…"
for i in $(seq 1 30); do
    STATUS="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' hev-lifecycle 2>/dev/null || echo missing)"
    if [ "$STATUS" = "healthy" ]; then
        PORT="$(grep -E '^HEV_PORT=' .env | cut -d= -f2)"
        log "部署完成：http://<服务器IP>:${PORT:-18480}"
        exit 0
    fi
    if [ "$STATUS" = "unhealthy" ]; then
        docker compose logs --tail=50
        die "容器健康检查失败，请查看上方日志"
    fi
    sleep 2
done

docker compose ps
die "健康检查超时，请执行 docker compose logs 查看原因"
