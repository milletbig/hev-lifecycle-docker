#!/usr/bin/env bash
# 初始化宿主机目录权限：容器以 uid/gid 10001 运行，需要可写 data 目录
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${HEV_DATA_DIR:-$BASE_DIR/data}"

mkdir -p "$DATA_DIR/backups"
chown -R 10001:10001 "$DATA_DIR"
chmod 700 "$DATA_DIR" "$DATA_DIR/backups"
[ -f "$BASE_DIR/.env" ] && chmod 600 "$BASE_DIR/.env"

# 允许容器写入挂载目录（SELinux 开启时需要 :z 重新打标签，由 compose 调用方处理）
echo "[init] 数据目录已就绪：$DATA_DIR"
