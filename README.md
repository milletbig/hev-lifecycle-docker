# 混动车全生命周期记录 · 容器化交付包

在完整保留原有页面全部功能（数据录入、查询、图表、车辆/类别/标签管理、导入导出、拖拽排序、角色设置等）的前提下，新增安全登录、服务端数据持久化与 Docker 一键部署。

## 快速开始

```bash
cd /home/shawn/hev-lifecycle
bash scripts/deploy.sh          # 首次会提示设置管理员密码（仅保存 scrypt 散列）
```

部署完成后访问：`http://<服务器IP>:18480`

- 未登录访问任何页面、脚本或数据接口都会被拦截（302 跳转登录页 / 401）。
- 登录后的数据自动同步到 `/home/shawn/hev-lifecycle/data/state.json`，每次记录变更立即备份，并按设置页配置的周期自动备份。
- 原有页面业务脚本 `app/assets/app.js` 与原 HTML 内联脚本 **SHA-256 完全一致**，模板结构逐字保留，仅将 CDN 依赖改为本地文件。

## 自动重启策略

容器在 `docker-compose.yml` 中配置 `restart: unless-stopped`，并由 `deploy.sh` 确保 Docker 服务开机自启（`systemctl enable docker`）。覆盖以下场景：

| 场景 | 是否自动恢复 | 说明 |
| --- | --- | --- |
| 容器内 Node 进程崩溃 / 非预期退出 | 是 | Docker 立即重新拉起容器，健康检查恢复正常 |
| 容器因 OOM、异常错误退出 | 是 | 受 256 MiB 内存限制保护，退出后自动重启 |
| 宿主机重启 / Docker daemon 重启 | 是 | Docker 服务开机自启后自动启动容器 |
| 人工 `docker stop` / `docker kill` / `docker compose stop` | 否 | 属于人工停止，`unless-stopped` 不会自动拉起 |

常用运维命令：

```bash
docker inspect -f '{{.HostConfig.RestartPolicy.Name}} {{.RestartCount}} {{.State.Health.Status}}' hev-lifecycle
docker compose -f /home/shawn/hev-lifecycle/docker-compose.yml ps
systemctl is-enabled docker
```

## 自动备份

### 触发时机

1. **记录变更即时备份**：新增记录、修改任意一条记录、删除记录或调整设置后，前端在 800 ms 防抖后同步到服务端；服务端检测到数据内容哈希变化，立即异步生成一份完整快照。备份在独立队列执行，不阻塞保存接口响应。
2. **周期自动备份**：按设置页“自动备份周期(天)”定时生成快照，与数据是否变化无关；默认 **7 天**，可在设置页调整为 1~365 天。

### 备份文件与保留规则

- 目录：`/home/shawn/hev-lifecycle/data/backups/`
- 命名：`state-<UTC时间>-rev<版本号>-change.json`（变更备份）、`state-<UTC时间>-rev<版本号>-scheduled.json`（周期备份）
- 保留策略：仅保留最新 **30** 份，超出后自动删除最旧的备份（可由 `.env` 的 `BACKUP_KEEP` 调整，默认 30）
- 周期状态：`/home/shawn/hev-lifecycle/data/backup-schedule.json` 记录上次周期备份时间，服务启动时自动校验是否到期
- 完整性：备份与主数据均采用“临时文件 + `fsync` + 原子重命名”写入，避免半写文件；单份备份为完整 `state.json` 快照

### 配置与恢复

| 配置项 | 位置 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 自动备份周期 | 设置页 → 图表与业务参数设置 | 7 天 | 1~365 天，保存后立即生效，无需重启 |
| `BACKUP_KEEP` | `.env` | 30 | 保留备份数量上限，修改后需重建容器 |
| 备份目录 | `data/backups` | 自动创建 | 随数据目录挂载持久化 |

```bash
ls -lt /home/shawn/hev-lifecycle/data/backups | head
bash /home/shawn/hev-lifecycle/scripts/restore.sh <备份文件路径>   # 恢复指定备份
```

## 目录迁移说明（/usr/shawn → /home/shawn）

项目已于 2026-11-18 整体迁移至 `/home/shawn/hev-lifecycle`，旧目录 `/usr/shawn/hev-lifecycle` 已清理。当前唯一有效部署路径为 `/home/shawn/hev-lifecycle`，请勿再从旧路径执行 `docker compose`。

### 迁移范围

- 全部文件、子目录、隐藏配置（`.env`、`.env.example`、`.dockerignore`、`.gitignore`）、`app/vendor/` 依赖、`config-backup/` 归档均已完整复制。
- `data/` 目录随项目迁移，包含 `state.json`、`backups/`、`session.secret`、`backup-schedule.json`；权限与属主保留（目录 0700，数据/密钥 0600，uid 10001）。
- `.env` 的 `HEV_DATA_DIR`、`docker-compose.yml` 的数据卷默认值、README 与全部文档中的路径引用均已改为新路径。
- 部署、备份、恢复、初始化脚本均通过 `BASE_DIR` 动态定位项目根目录，无需修改。

### 再次迁移的可复用步骤

```bash
# 1. 停止容器，避免复制过程中数据写入
docker compose -f /home/shawn/hev-lifecycle/docker-compose.yml stop

# 2. 完整复制（保留权限、属主、软链接）
cp -a /home/shawn/hev-lifecycle /新路径/hev-lifecycle

# 3. 更新新目录 .env 中的 HEV_DATA_DIR，并确认无旧路径残留
grep -rn "/home/shawn/hev-lifecycle" /新路径/hev-lifecycle

# 4. 从新目录重建容器（挂载配置变更必须重建）
cd /新路径/hev-lifecycle
docker compose up -d --build --force-recreate
```

### 迁移后验证要点

- `docker inspect hev-lifecycle`：健康状态 `healthy`，挂载源指向新路径；
- `curl http://127.0.0.1:18480/healthz` 返回 200，`state.json` 的 `rev` 连续；
- `data/backups/` 备份数量与迁移前一致，历史备份可正常恢复；
- `https://hev.peachyjoy.top` 首页 302、`/login` 200、未授权资源 401；
- 旧目录删除后服务无感知，容器仍在 `unless-stopped` 策略下自动重启。

## 文档

| 文档 | 内容 |
| --- | --- |
| [01-环境兼容性评估](docs/01-环境兼容性评估.md) | 操作系统、内核、Docker、资源配额实测与自构建可行性结论 |
| [02-性能影响评估](docs/02-性能影响评估.md) | CPU、内存、磁盘 IO、网络带宽的量化实测与结论 |
| [03-部署操作手册](docs/03-部署操作手册.md) | 部署步骤、登录配置、数据备份恢复、日常运维、故障排查 |
| [04-域名反代与自启动配置](docs/04-域名反代与自启动配置.md) | hev 子域名 Nginx/Xray 配置、验证记录、开机自启动与镜像构建说明 |

## 关键实测指标

- 镜像 135.8 MiB；冷启动至健康 1.96 s
- 空载内存 17.1 MiB；压测峰值 29.1 MiB；登录校验瞬时 72.3 MiB（上限 256 MiB）
- 压测峰值 CPU 0.74 核（宿主机 2 核的 37%）；持续吞吐约 774 req/s
- 服务端处理耗时平均 1.5 ms，P95 6 ms，P99 16 ms
- 首屏 gzip 传输约 863 KiB，之后强缓存约 33 KiB

## 目录

```
app/      前端（含 vendor 本地依赖、boot.js 鉴权引导）
server/   Node 服务（登录、会话、静态托管、数据持久化）
scripts/  部署、初始化、备份、恢复、口令散列
docs/     评估报告与运维手册
data/     运行数据（自动生成）
```

## 安全默认值

- 无内置密码，未配置口令时服务拒绝启动（默认拒绝）。
- scrypt 口令散列、HttpOnly + SameSite=Strict 会话、登录失败锁定、CSP、CSRF 同源校验。
- 容器非 root、只读根文件系统、`cap_drop: ALL`、256 MiB / 1 CPU / 128 进程限制。
- 数据与备份文件权限 0600，退出登录清除浏览器缓存。
