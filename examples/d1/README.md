# 可选 D1 路由模板

`app/api/notes/route.ts.example` 是供启用 D1 的项目复制的路由模板。当前平台使用 Node.js API、SQLite 元数据和 MySQL 数据源，没有启用 D1，也没有安装 Drizzle 或提供 D1 数据层，因此该模板使用 `.example` 后缀，不作为当前应用的 TypeScript 源码编译。

使用时，将模板复制为目标项目的 `app/api/notes/route.ts`，并先准备：

- 目标项目的 D1 绑定及 `drizzle-orm` 依赖。
- 根目录 `db/index.ts` 导出的 `getDb()`，返回绑定该数据库的 Drizzle 实例。
- 根目录 `db/schema.ts` 导出的 `notes` 表，包含 `id`、`title`、`content` 和 `createdAt` 字段，以及对应迁移。

模板的相对导入按复制后的路径解析。复制到应用目录后，它应与目标项目一起接受类型检查。当前平台的 `app/`、`worker/` 和构建配置继续由根目录 TypeScript 配置检查。
