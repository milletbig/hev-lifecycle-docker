#!/usr/bin/env bash
# 数据恢复：停止容器 -> 自动备份当前数据 -> 覆盖 state.json -> 启动并等待健康
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$BASE_DIR"

if [ $# -lt 1 ]; then
    echo "用法：bash scripts/restore.sh <备份文件.tar.gz|state.json>" >&2
    exit 1
fi

SRC="$1"
[ -f "$SRC" ] || { echo "[restore] 文件不存在：$SRC" >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

case "$SRC" in
    *.tar.gz|*.tgz)
        tar -xzf "$SRC" -C "$TMP_DIR" state.json
        ;;
    *.json)
        cp "$SRC" "$TMP_DIR/state.json"
        ;;
    *)
        echo "[restore] 仅支持 .tar.gz 或 .json" >&2
        exit 1
        ;;
esac

python3 - "$TMP_DIR/state.json" <<'PY'
import json, sys
raw = open(sys.argv[1], encoding='utf-8').read()
obj = json.loads(raw)
assert isinstance(obj, dict) and isinstance(obj.get('data'), dict), 'state.json 结构不合法'
print('[restore] 校验通过：rev=%s, 键=%d' % (obj.get('rev'), len(obj['data'])))
PY

bash scripts/backup.sh || true

echo "[restore] 停止容器…"
docker compose stop

install -m 600 -o 10001 -g 10001 "$TMP_DIR/state.json" "$BASE_DIR/data/state.json"
echo "[restore] 数据已覆盖，启动容器…"
docker compose up -d

for i in $(seq 1 30); do
    STATUS="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' hev-lifecycle 2>/dev/null || echo missing)"
    if [ "$STATUS" = "healthy" ]; then
        echo "[restore] 恢复完成，服务已健康"
        exit 0
    fi
    sleep 2
done

echo "[restore] 健康检查超时，请执行 docker compose logs --tail=50 排查" >&2
exit 1
