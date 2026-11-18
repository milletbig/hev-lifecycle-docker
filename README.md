# 混动车全生命周期记录 · 容器化交付包

在完整保留原有页面全部功能（数据录入、查询、图表、车辆/类别/标签管理、导入导出、拖拽排序、角色设置等）的前提下，新增安全登录、服务端数据持久化与 Docker 一键部署。

## 快速开始

```bash
git clone git@github.com:milletbig/hev-lifecycle-docker.git
cd hev-lifecycle-docker
bash scripts/deploy.sh          # 拉取已构建镜像；首次会提示设置管理员密码（仅保存 scrypt 散列）
```

部署完成后访问：`http://<服务器IP>:18480`

- 未登录访问任何页面、脚本或数据接口都会被拦截（302 跳转登录页 / 401）。
- 登录后的数据自动同步到项目目录下的 `data/state.json`，每次记录变更立即备份，并按设置页配置的周期自动备份。
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
docker compose ps          # 在项目目录执行
systemctl is-enabled docker
```

## 自动备份

### 触发时机

1. **记录变更即时备份**：新增记录、修改任意一条记录、删除记录或调整设置后，前端在 800 ms 防抖后同步到服务端；服务端检测到数据内容哈希变化，立即异步生成一份完整快照。备份在独立队列执行，不阻塞保存接口响应。
2. **周期自动备份**：按设置页“自动备份周期(天)”定时生成快照，与数据是否变化无关；默认 **7 天**，可在设置页调整为 1~365 天。

### 备份文件与保留规则

- 目录：`data/backups/`
- 命名：`state-<UTC时间>-rev<版本号>-change.json`（变更备份）、`state-<UTC时间>-rev<版本号>-scheduled.json`（周期备份）
- 保留策略：仅保留最新 **30** 份，超出后自动删除最旧的备份（可由 `.env` 的 `BACKUP_KEEP` 调整，默认 30）
- 周期状态：`data/backup-schedule.json` 记录上次周期备份时间，服务启动时自动校验是否到期
- 完整性：备份与主数据均采用“临时文件 + `fsync` + 原子重命名”写入，避免半写文件；单份备份为完整 `state.json` 快照

### 配置与恢复

| 配置项 | 位置 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 自动备份周期 | 设置页 → 图表与业务参数设置 | 7 天 | 1~365 天，保存后立即生效，无需重启 |
| `BACKUP_KEEP` | `.env` | 30 | 保留备份数量上限，修改后需重建容器 |
| 备份目录 | `data/backups` | 自动创建 | 随数据目录挂载持久化 |

```bash
ls -lt data/backups | head
bash scripts/restore.sh <备份文件路径>   # 恢复指定备份
```

## 事件记录排序与分组

事件记录表格按日期分组展示，排序规则如下：

1. **日期倒序**：最新日期的分组排在最前，组头展示日期、记录条数与当日收支合计；
2. **里程倒序**：组内包含里程的记录按里程数值倒序（总里程优先，缺失时回退 HEV + EV）；
3. **手动排序**：组内无里程的记录保持新增置顶的默认顺序，可在同一日期分组内拖拽调整。

含里程记录的拖拽手柄为禁用态，避免与里程排序冲突；只读角色不可拖拽。分页仍为每页 10 条，跨页的同日期会各自显示组头。

详细说明见服务器本地 `docs/05-事件记录排序优化.md`（`docs/` 含运维信息，按约定不入库）。

## 镜像发布

镜像由 GitHub Actions 在推送 `v*.*.*` 标签时自动构建，并发布到 GitHub Container Registry：

| 项目 | 值 |
| --- | --- |
| 镜像地址 | `ghcr.io/milletbig/hev-lifecycle-docker` |
| 标签 | `1.0.2`、`1.0`、`latest`、`sha-<commit>` |
| 架构 | `linux/amd64`、`linux/arm64` |

升级到新版本时，修改 `docker-compose.yml` 中的镜像标签后执行：

```bash
docker compose pull
docker compose up -d
```

如需从源码自行构建，在 `docker-compose.yml` 中补回 `build: .`，再执行 `docker compose up -d --build`。

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
data/     运行数据（自动生成）
```

## 安全默认值

- 无内置密码，未配置口令时服务拒绝启动（默认拒绝）。
- scrypt 口令散列、HttpOnly + SameSite=Strict 会话、登录失败锁定、CSP、CSRF 同源校验。
- 容器非 root、只读根文件系统、`cap_drop: ALL`、256 MiB / 1 CPU / 128 进程限制。
- 数据与备份文件权限 0600，退出登录清除浏览器缓存。
