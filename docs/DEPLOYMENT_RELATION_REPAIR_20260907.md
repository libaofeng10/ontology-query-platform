# 数据源关系修复与 TypeScript 清理部署记录

日期：2026-09-07。目标服务器：39.107.117.246。用户已指定该服务器继续实施，并选择先对现有已确认关系做回归。未创建 Git commit。

## 部署结果

- 新镜像：`sha256:e8500fe24be1879fc2c211e3e71d5ad17cce52c5acd428d315748c9b0eb9a871`。
- 发布目录：`/data/ontoquery-releases/relation-repair-20260907T085355Z`。
- 回退镜像：`ontology-query-platform-ontoquery:relation-repair-20260907T085355Z-backup`，指向原镜像 `sha256:0896420c978eac9dcfc60efc40e84ad25c0e0725bbd1718768d815bc6d1ce72d`。
- 保留原 `.env.production`、`.env.local`（若存在）、`compose.override.yaml` 和 runtime 挂载。配置文件哈希在切换前后保持一致。
- 停止服务后备份一致性 SQLite、完整数据与知识目录，再切换已验证的新镜像；部署脚本包含失败回退。
- 外部网页 `http://39.107.117.246/` 返回 200；容器健康，API ready 返回 200，未认证 bootstrap 返回 401。

## 构建与迁移证据

源码按当前工作区打包，不依赖尚未提交的 Git 状态。输入包包含 250 个文件，SHA-256 为 `71dbd1d8e0e29f31d13a6ca34843e7b772253f37b45e87fbfa6b268648e3c9c0`。清单 SHA-256 为 `3c3a2997185ad8365f6768216c06c6dd408426cae4779e63ff8db795349c68c6`。

依赖清单及 package-lock 与运行镜像一致，复用其 Linux 依赖后，在无外网、未挂载生产数据的候选镜像中运行 `npm run check`：TypeScript 0 错误、ESLint 与构建通过、645 项测试通过、页面渲染 1 项通过。

生产数据库副本的迁移预演逐表比较 32 张表：

- 1,412 条历史关系保留原 ID 和原始业务字段；本库没有需要停用的旧 foreign_key 记录。
- 纠正 17 个不能由旧目录证明的唯一键标记；新增完整列组和证据字段。
- SQLite quick_check 为 ok，foreign_key_check 无错误。
- 当前已发布 Schema 校验通过。启动后真实数据源、关系、字段、知识、版本、设置及选表指纹保持符合预期。

线上核验确认 248 个文件与源码输入逐一匹配。其余两项为明确的构建处理：`.env.example` 按 `.dockerignore` 规则不进入镜像；Docker 为外部构建文件向 `.dockerignore` 追加一个随机文件名排除项，去除该自动追加项后原内容哈希一致。

11 类生产业务表按迁移预期逐项比较通过。当前生效版本仍为 id 12 / v11，包含 26 个对象、36 条业务关系。保留 auto_draft / 85、Claude required / glm-5.2-fast-preview、SQL 预算 5，列画像关闭。

Nginx 实际返回 `/_next/static/chunks/platform-app-juyJHVCK.js`，与容器资源内容一致，SHA-256：`9f6c2ec60ffc371cd9dde8ad69feeb0c8d720f76a9366b405a40cc375eee0524`。

## 历史关系回归准备与当前边界

已从发布前目录导出当前 26 张选中表内、去重后的 90 条已确认关系，使用 `complete=false`。该清单是历史回归参考，包含既往模型或文档辅助确认结果，不是独立业务真值；已验证知识也可能包含这些关系，不能据此标定真实精确率或自动确认阈值。服务器没有配置 Gold SQL 评测集。

在独立容器中使用元数据只读副本、只读业务查询和现有模型配置执行评测。模型服务为 `https://dashscope.aliyuncs.com`，模型 `glm-5.2-fast-preview`，列画像保持关闭；模型输入包含结构、注释、关系匹配统计及已验证业务知识。

用户已明确回复“允许本次真实模型回归”，此前自动审批审查要求的数据出站授权已满足。已启动容器 `ontoquery-relations-regression-20260907T085355Z`。启动校验强制核对服务域名、模型、数据源、26 张选表与 90 条参考关系、列画像关闭和 85 分门槛；任一不符即停止。容器不挂载生产 runtime，元数据副本只读挂载，评测工作库在临时目录中。

当前正在执行真实 MySQL 与模型回归。生产目录重探、本体重建或发布新版本均未执行，阈值未调整。

## 回退资料

发布目录中保留 `platform-before-cutover.sqlite`、`runtime-before.tgz`、`source-and-config-before.tgz`、`source-manifest.json`、构建与切换日志，以及 `preflight/migration-report.json`、`production-verification.json`。数据库和环境配置备份仅存于服务器的私有发布目录，不随本文或源码分发。

若需回退，应先停止容器、保留切换后的数据副本，再恢复一致性数据与知识备份、原服务器配置和回退镜像。切换后如已产生新业务写入，应先评估并保留这些新增记录，不直接用旧数据库覆盖。
