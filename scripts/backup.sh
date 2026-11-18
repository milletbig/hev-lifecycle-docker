#!/usr/bin/env bash
# 手动备份：仅打包业务数据 state.json，不含会话密钥与口令文件
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_FILE="$BASE_DIR/data/state.json"
DEST_DIR="${HEV_BACKUP_DIR:-$BASE_DIR/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST_DIR/state-$STAMP.tar.gz"

mkdir -p "$DEST_DIR"

if [ ! -f "$DATA_FILE" ]; then
    echo "[backup] 未找到 $DATA_FILE，暂无可备份数据" >&2
    exit 1
fi

tar -czf "$OUT" -C "$BASE_DIR/data" state.json
tar -tzf "$OUT" >/dev/null
echo "[backup] 已生成：$OUT ($(du -h "$OUT" | cut -f1))"
