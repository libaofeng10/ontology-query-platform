# Docker / containerd 数据盘迁移（2026-09-05）

目标服务器：`39.107.117.246`（rock-ontology-query-node01-0-111）。用户明确授权迁移。未操作 `39.96.34.126`。

## 原因与范围

系统盘为 40G ext4，清理构建缓存后仍使用 94%；另有 100G XFS 数据盘 `/data`，迁移前仅使用 2G。

Docker 29.1.3 使用 containerd image store，containerd 为 2.2.1。`/var/lib/docker` 约 1.7G，独立的 `/var/lib/containerd` 约 31G。两个目录必须同时迁移，单独调整 Docker `data-root` 不会移动 containerd 的镜像与快照，见 [Docker 官方数据目录说明](https://docs.docker.com/engine/daemon/#configure-the-data-directory-location)。

| 内容 | 原目录 | 新目录 |
| --- | --- | --- |
| Docker 配置、容器元数据和缓存 | `/var/lib/docker` | `/data/docker` |
| containerd 镜像和快照 | `/var/lib/containerd` | `/data/containerd` |
| containerd 临时运行状态 | `/run/containerd` | 保持原值 |
| 平台数据库和知识文件的业务挂载 | 项目目录下 `runtime/data`、`runtime/wiki` | 保持原挂载，停机时另行备份 |

数据盘 UUID 为 `92f380b4-856b-4da5-bb80-b1ec466ef3c7`，`/etc/fstab` 已配置持久挂载；XFS 支持 ftype=1、reflink=1。

## 执行设计

1. 在线使用 rsync 保留权限、数字 UID/GID、硬链接、ACL、扩展属性及稀疏文件，预复制两个存储目录。
2. 在数据盘 `/data/ontoquery-storage-migration-20260905` 保存原配置、容器完整清单、镜像标识和迁移日志；该目录权限为 700，凭据不输出到日志或本地。
3. 停止业务容器、Docker/socket、containerd，确认存储目录没有残留挂载，再做最终同步和目录比较，并备份业务数据库/知识文件。
4. 利用 XFS reflink 在数据盘创建两个完整的独立回退目录，位于备份下的 `roots/docker`、`roots/containerd`。文件写入时使用写时复制，不与活动目录共享可变的硬链接。
5. Docker `daemon.json` 合并 `data-root=/data/docker`，保留原镜像源设置；containerd 基于原有效配置仅修改 `root=/data/containerd`，保留 `/run/containerd` 和其他配置。
6. 为两个 systemd 服务增加 `RequiresMountsFor=/data` 和 `ConditionPathIsMountPoint=/data`。先把系统盘原目录改名为 `.pre-data-20260905`，再启动，防止误用旧位置而得到假成功。
7. 检查原容器/镜像/业务挂载/环境一致、全部镜像保留、SQLite 完整性、设置指纹、知识文件、历史记录、网页/API/ready、Claude CLI 和挂载依赖。切换脚本在该阶段失败会恢复原目录和配置。
8. 全部验证通过后，确认数据盘回退目录与停机原目录一致，才清理系统盘副本，释放空间。

## 回退边界

`cutover.py` 中的自动恢复只用于系统盘 `.pre-data-20260905` 副本仍存在的切换阶段。完成清理后，不可直接调用该恢复函数。

清理后的回退材料仍在数据盘备份目录。若需恢复旧位置，应先停业务容器和两个守护进程，在确认系统盘容量足够后，将 `roots/docker` 与 `roots/containerd` 同步回 `/var/lib`，恢复备份的 daemon.json，恢复 containerd 原配置状态（本次原文件不存在），移除本次的两个 `20-ontoquery-data-mount.conf`，再重载并启动服务及原业务容器。业务挂载保持最新数据，不自动覆盖为停机备份。

## 实际结果

迁移已完成，服务器备份目录的 `phase` 为 `complete`，`verification.json` 记录验收和空间释放结果。

| 挂载 | 迁移前 | 迁移后 | 迁移后可用 |
| --- | --- | --- | --- |
| 系统盘 `/`（40G） | 35G / 94% | 4.1G / 11% | 34G |
| 数据盘 `/data`（100G） | 2G / 2% | 35G / 35% | 66G |

- 原容器 ID `3d604cd58e2d26483d302327132b01573015f58bf81b975d71c9c5c86bd112c2`、运行镜像 `sha256:2b25e203d96ca97b786b7fa070dd8aa1195c2188a8870f56a52adbc03c7a954a`、完整环境和业务挂载均保持一致。
- 迁移前后镜像清单的 20 条条目完全一致，包含回退标签；没有清理镜像。
- SQLite quick_check 通过，设置记录指纹一致，1,387 个知识文件内容一致；验收时会话 18、消息 34、审计 143，未发生记录减少。
- 网页、API health、API ready 均为 200；Claude CLI 版本检查为 `2.1.258 (Claude Code)`；原容器健康。
- Docker 实际根目录为 `/data/docker`；containerd 有效配置根目录为 `/data/containerd`，运行状态仍为 `/run/containerd`。两个服务均已验证依赖 `data.mount`。
- 系统盘 `.pre-data-20260905` 原副本在数据盘回退目录比对一致并刷盘后才删除；回退副本位于 `roots/docker`、`roots/containerd`，业务文件备份位于 `app-runtime`。
- 最终切换日志从 10:13:18 UTC 停止容器到 10:14:24 UTC 通过验收，约 66 秒；此前两次回退产生的停机时间另计。未重启整台服务器，未做新的外部模型或业务数据查询回放。

第一次尝试因 `/etc/containerd` 父目录不存在而失败，在改名存储目录之前自动恢复原配置和服务。第二次已在数据盘成功启动，但验收错误地按列表顺序比较 Docker Mounts，因顺序变化触发自动回退；核对路径与权限完全一致后改为按 Destination 排序比较完整字段。第三次全部通过。旧脚本和日志均保留，重试前的回退副本保留于 `roots-before-retry-*`，使用 XFS 写时复制共享底层只读内容。

本次仅增加运维交接文档，未修改应用代码、查询配置或提交 git commit。
