# 部署与运维

## Docker Compose

1. 复制 `deploy/env.production.example` 为仓库根目录的 `.env.production`。
2. 为 `APP_SECRET`、各角色 token 和 `LLM_API_KEY` 使用独立随机值；不要复用示例或开发值。
3. 将 `ALLOWED_ORIGINS` 收敛为实际 Web 地址。
4. 构建并启动：`docker compose up -d --build`。
5. 验证 `GET http://127.0.0.1:8787/api/ready` 和 Web `http://127.0.0.1:3000`。

容器默认丢弃 Linux capabilities、启用 `no-new-privileges`、根文件系统只读，并把 SQLite 与 Markdown 本体放在 `ontoquery-data`、`ontoquery-wiki` 两个持久卷中。API/Web 端口默认只绑定宿主机回环地址；对外服务时应放到启用 TLS、请求体限制和访问日志脱敏的反向代理之后。

## 身份与权限

`API_IDENTITIES_JSON` 中每个身份包含：

- `name`：审计用户名；
- `role`：`viewer`、`analyst`、`editor` 或 `admin`；
- `token`：Bearer token；
- `sourceIds`：`"*"` 或允许访问的数据源 ID 数组。

浏览器登录页把 token 放在当前标签页的 `sessionStorage`，不会写入构建产物或长期本地存储。生产构建不要设置 `NEXT_PUBLIC_API_WRITE_TOKEN`。`API_WRITE_TOKEN` 只用于兼容本地单管理员模式。

启用 AI 本体 M4 校准时，至少配置两个 `name` 不同且有同一试点数据源权限的 `editor`/`admin` 身份：一个执行候选首轮审核，另一个写入独立双检标签。同一审计身份即使只改变大小写或空白也不能同时承担两个步骤。

## 备份与恢复

备份必须同时覆盖 SQLite 和 Markdown 本体卷，并在开始前停止服务，确保两者位于同一一致性点：

```bash
docker compose stop ontoquery
docker run --rm -v ontology-query-platform_ontoquery-data:/data -v "$PWD/backups:/backup" debian:bookworm-slim tar -C /data -czf /backup/data.tgz .
docker run --rm -v ontology-query-platform_ontoquery-wiki:/wiki -v "$PWD/backups:/backup" debian:bookworm-slim tar -C /wiki -czf /backup/wiki.tgz .
docker compose start ontoquery
```

恢复前先保留现有卷的副本；在空的新卷中解压备份，启动后检查 `/api/ready`、数据源列表、Schema 版本和知识页数量。凭据恢复依赖原 `APP_SECRET`，因此密钥应使用独立的秘密管理系统备份。

## 上线验收

- viewer 只能读取授权数据源，不能问数或写知识；analyst 可问数；editor 可探查、维护知识和评测；admin 可新增数据源。
- 未带 token、越权数据源、超限请求分别返回 401、403、429。
- 真实 MySQL 账号无法创建临时表；LLM 未配置时真实源明确拒答。
- 异步探查重启后恢复，Schema 删除只失效元数据、不物理删除历史。
- Held-out Gold SQL 不出现在 bootstrap、列表或保存响应。
- `auto_draft` 校准只接受当前发布 Schema 的发布后语义门禁；修改评测集、替换发布版本、未实际进入语义计划或使用 Agent 门禁都会使旧证据失效。
- 备份恢复演练后 SQLite、Markdown、加密数据源凭据一致可用。
