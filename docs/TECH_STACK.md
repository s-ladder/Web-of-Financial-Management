# 分寸账本技术栈与架构说明

本文根据仓库当前实现整理，描述的是现有行为，不代表尚未实现的规划。版本信息以 `package.json`、`pnpm-lock.yaml` 和 `render.yaml` 为准；部署平台的套餐、配额和运行规则可能变化。

## 技术栈与版本

| 层次 | 技术 | 仓库中可确认的版本或配置 |
| --- | --- | --- |
| 运行时 | Node.js | `package.json` 要求 `>=22.13.0`；Render 配置指定 `22.13.0`。 |
| 包管理器 | pnpm | `package.json` 声明 `pnpm@11.25.0`；依赖安装使用锁文件。 |
| HTTP 服务 | Express | 声明范围 `^5.3.0`；锁文件解析为 `5.3.0`。 |
| PostgreSQL 驱动 | `pg` | 声明范围 `^8.23.1`；锁文件解析为 `8.23.1`。 |
| 本地数据库 | Node.js 内置 `node:sqlite` | 通过同步 `DatabaseSync` 访问；没有独立 SQLite npm 依赖。 |
| 浏览器端 | 原生 HTML、CSS、JavaScript | ES module、DOM、Fetch、原生 SVG；没有前端框架或打包器依赖。 |
| 测试 | Node.js 内置测试工具 | `node --test`，通过 `pnpm test` 执行集成测试。 |

不要把版本声明范围误读为已安装版本：锁文件确认的是当前锁定版本，实际部署解析仍受锁文件与安装命令约束。

## 架构

应用是一个由单个 Node.js 进程提供的同源 Web 服务：Express 提供 JSON REST API，并托管 `public/` 下的静态页面；浏览器端 JavaScript 通过 `fetch` 调用 API。没有独立前端服务器、SSR、构建步骤、消息队列或微服务。

```text
浏览器 public/index.html + app.js + styles.css
             │ 同源 HTTP / Cookie 会话
             ▼
Express（server/index.js、server/app.js）
             │ 数据库适配器（server/database.js）
             ├── node:sqlite / data/ledger.sqlite（本地默认）
             └── pg Pool / DATABASE_URL（PostgreSQL，例如 Neon）
```

启动入口 `server/index.js` 创建 Express 应用并监听端口。`PORT` 默认是 `3000`；`HOST` 默认是本地的 `127.0.0.1`，生产模式默认监听 `0.0.0.0`。应用启动时初始化数据库表；生产环境没有 `DATABASE_URL` 时会拒绝使用本地 SQLite 启动。

## 数据库、适配器与隔离

### 数据库切换

- **SQLite：** 未设置 `DATABASE_URL` 时使用 `DATABASE_PATH`，默认 `./data/ledger.sqlite`。SQLite 启用外键和 WAL 日志。数据库操作通过统一的 `get`、`all`、`run`、`exec`、`transaction` 接口调用。
- **PostgreSQL：** 设置 `DATABASE_URL` 后，适配器创建 `pg.Pool`，最多 5 个连接，连接超时 10 秒。适配层把应用 SQL 中的 `?` 参数占位符转换为 PostgreSQL 的 `$1`、`$2` 等格式；事务使用单独的池连接并在结束时释放。
- 表结构由 `server/database.js` 中的 `CREATE TABLE IF NOT EXISTS` 在启动时初始化。项目没有独立迁移工具或版本化迁移脚本。

### 数据模型

| 表 | 主要字段 | 用途 |
| --- | --- | --- |
| `users` | `id`、`name`、`email`、`password_hash`、`password_salt`、`created_at` | 账户与密码凭据。邮箱有唯一约束。 |
| `sessions` | `token_hash`、`user_id`、`expires_at` | 服务端会话记录；用户外键带 `ON DELETE CASCADE`。 |
| `transactions` | `id`、`user_id`、`kind`、`amount`、`category`、`note`、`occurred_on`、`created_at` | 收支流水；类型及正金额由数据库约束。 |

金额在数据库中以整数分保存，输入金额限制为正数且不超过 1 亿元；日期以 `YYYY-MM-DD` 字符串保存。SQLite 使用 `INTEGER` 主键和金额，PostgreSQL 使用 `BIGSERIAL` 主键和 `BIGINT` 金额。

所有账户共享数据库和相同表结构，**不是**每位用户独立数据库或独立 schema。隔离依靠服务端会话确定的 `user_id` 与查询条件实现：流水列表、统计、导出、更新和删除均按当前用户过滤；创建或导入记录时，所有者 ID 取自会话而不是请求参数。项目没有数据库行级安全策略（RLS），因此隔离边界在应用代码中。

注册时邮箱会被转为小写，登录也使用小写邮箱；SQLite 另使用 `COLLATE NOCASE`，PostgreSQL schema 没有声明对应的 `NOCASE` 规则。通过应用注册流程时会做规范化，但直接写入数据库或从外部导入用户时不能假设两个数据库的邮箱比较规则完全等价。

## 认证、会话与安全

- 注册密码要求 8–72 位并同时包含英文字母和数字。每个账户生成 16 字节随机盐，使用 Node.js `scrypt` 派生 64 字节密码哈希；登录采用 `timingSafeEqual` 比较哈希，账户不存在时也执行一次哈希运算。
- 登录或注册成功时生成 32 字节随机会话令牌，以 Base64URL 编码交给浏览器；数据库只保存令牌的 SHA-256 哈希。会话有效期为 7 天，不依赖进程内存，数据库保持可用时应用重启后仍可验证。登出会删除该会话记录并清空 Cookie。
- Cookie 名为 `fencun_session`，设置 `HttpOnly`、`SameSite=Lax`、`Path=/` 和 7 天 `Max-Age`；生产模式另加 `Secure`。生产模式信任一个反向代理跳数，以支持部署平台代理后的请求信息。
- 服务端关闭 `X-Powered-By`，并设置 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy` 和 Content Security Policy。CSP 的样式策略允许 `'unsafe-inline'`。JSON 请求体上限为 64 KB；导入 CSV 请求上限为 2 MB。参数值通过数据库绑定参数传递。
- 前端将用户名、分类、备注和错误信息写入 DOM 时使用 `textContent`，而不是把用户内容拼入 HTML 字符串。
- 演示账户为 `demo@fencun.local` / `Fencun2026!`，只在非生产模式且未设置 `DISABLE_DEMO=true` 时开放；生产模式下演示登录路由返回 404。生产部署不可将环境配置成非生产模式。
- 登录失败限速在进程内按 IP 计数：15 分钟窗口内达到 10 次失败后，认证中间件拒绝该 IP 的后续请求。该状态不跨进程或重启共享，也不是持久化的全局限流。

**安全边界：** `SameSite=Lax` 提供浏览器层面的跨站请求缓解，但代码没有独立 CSRF Token 或 Origin 校验；没有配置 Helmet、账号验证、找回密码、审计日志或持久化/分布式限流。服务自身不终止 TLS，生产环境应由 Render 等 HTTPS 反向代理提供 TLS，并使用可信的数据库连接串。该应用是个人账本示例，不应仅凭这些基础措施视作已完成生产安全审计。

## REST API

受保护端点使用同源 Cookie 会话；未登录时通常返回 `401`。写操作根据验证结果返回 `400`，缺少资源或资源不属于当前用户时返回 `404`。

| 方法与路径 | 权限 | 行为 |
| --- | --- | --- |
| `GET /api/config` | 公开 | 返回演示模式状态。 |
| `GET /api/session` | Cookie 会话 | 检查会话并返回公开用户信息。 |
| `POST /api/auth/register` | 公开 | 注册账户并创建会话。 |
| `POST /api/auth/login` | 公开 | 验证账户并创建会话。 |
| `POST /api/auth/logout` | Cookie 可选 | 删除当前会话并清理 Cookie。 |
| `POST /api/auth/demo` | 仅演示模式 | 创建演示账户会话；生产禁用。 |
| `GET /api/categories` | 登录 | 返回收入与支出分类。 |
| `GET /api/dashboard?month=YYYY-MM` | 登录 | 返回月度汇总、支出前六分类、最近六个月趋势和最近记录。 |
| `GET /api/transactions?month=YYYY-MM&kind=expense&q=...` | 登录 | 按月份、类型和分类/备注搜索流水；单次最多返回 1,000 条。 |
| `POST /api/transactions` | 登录 | 新建一条当前用户流水。 |
| `PUT /api/transactions/:id` | 登录 | 更新当前用户拥有的流水。 |
| `DELETE /api/transactions/:id` | 登录 | 删除当前用户拥有的流水，成功返回 `204`。 |
| `GET /api/export.csv` | 登录 | 导出当前用户全部流水。 |
| `POST /api/import.csv` | 登录 | 校验并原子导入当前用户的 CSV 流水。 |

月参数无效或缺失时使用服务端当前月份。搜索字符串最多取 80 个字符。接口只提供当前应用需要的功能，没有通用分页、排序或公开 API Token 认证。

## 前端渲染

- `public/index.html` 提供登录/注册、总览、流水列表和录入对话框的静态骨架；`public/app.js` 作为原生 ES module 执行，不经过转译或打包。
- 页面通过 DOM API 建立流水行、分类列表和图表；收支趋势以原生 SVG 绘制，分类占比以 CSS 宽度条显示，不依赖图表库。`Intl.NumberFormat` 用于人民币显示，`Intl.DateTimeFormat` 用于日期展示。
- 浏览器端维护当前用户、月份、收支筛选、搜索词及正在编辑的流水等内存状态；月度数据从 API 拉取。搜索输入有 180 毫秒防抖。静态 CSS 包含窄屏布局与减少动态效果的媒体查询。
- 页面与 API 由同一个 Express origin 提供，`fetch` 使用 same-origin 凭据；项目没有独立前端路由、客户端持久化账本或服务端渲染。

## CSV 导入与导出

模板及导出列为 `date,type,category,amount,note`。日期使用 `YYYY-MM-DD`；类型可用 `expense` / `income` 或“支出”/“收入”；分类必须属于服务端固定分类；金额最多两位小数；备注可省略，最长 120 个字符。导入最多 1,000 条记录，文件最大 2 MB。解析和验证全部行后，才在数据库事务中写入；任一行失败时不导入部分记录。CSV 由项目内的小型解析器处理，不提供方言自动识别；建议使用随页面提供的模板。

导出范围是当前用户的全部流水，而不是当前筛选月份。导出为 UTF-8 BOM 与 CRLF 换行的 CSV，金额转换回元；备注等以 `=`, `+`, `-`, `@` 或控制字符开头的单元格会加文本前缀，以降低电子表格公式注入风险。导入采用追加写入，没有去重、覆盖或更新匹配记录的逻辑。

CSV 仅迁移流水，不包含账户、密码哈希、会话或其他用户资料。因此 SQLite 与 PostgreSQL 间切换时需要分别处理账户创建；CSV 不是数据库级备份，也不包含数据库 schema。

## 本机运行

环境要求：Node.js `>=22.13.0` 和 pnpm（仓库声明 `pnpm@11.25.0`）。项目根目录执行：

```powershell
pnpm install
pnpm dev
```

`pnpm dev` 运行 `node --watch server/index.js`，默认打开 `http://localhost:3000`。首次创建本地数据库时，非生产模式会建立演示账户和样例流水。也可注册自己的账户。

仓库包含 `.env.example` 作为变量参考，但没有 `dotenv` 依赖或自动加载 `.env` 的代码；需要覆盖配置时，应在启动进程的 shell、IDE 或部署平台中设置环境变量。常用变量：

| 变量 | 用途 | 默认/说明 |
| --- | --- | --- |
| `PORT` | HTTP 监听端口 | `3000` |
| `HOST` | 监听地址 | 开发时 `127.0.0.1`；生产默认 `0.0.0.0` |
| `DATABASE_PATH` | SQLite 文件路径 | `./data/ledger.sqlite`；仅未设置 `DATABASE_URL` 时生效 |
| `DATABASE_URL` | PostgreSQL 连接串 | 设置后选择 PostgreSQL；生产必须设置 |
| `NODE_ENV` | 运行环境 | 设为 `production` 会关闭演示模式并启用生产 Cookie/代理配置 |
| `DISABLE_DEMO` | 在非生产环境关闭演示模式 | 仅字符串 `true` 生效 |

生产启动命令为 `pnpm start`。测试命令是 `pnpm test`，用于验证认证、权限隔离、输入校验和 CSV 流程。

## Render 与 Neon 部署

仓库中的 `render.yaml` 定义 Render Blueprint：Node Web Service、`free` 计划、构建命令 `pnpm install --frozen-lockfile`、启动命令 `pnpm start`、健康检查 `/api/config`；设置 `NODE_VERSION=22.13.0` 与 `NODE_ENV=production`，并要求部署时提供未同步进仓库的 `DATABASE_URL`。

部署步骤：

1. 在 Neon 创建 PostgreSQL 项目，取得供应商提供的连接串，并按供应商要求使用包含 TLS/SSL 参数的连接配置。
2. 将代码推送到 Render 可访问的 Git 仓库，在 Render 创建 Blueprint 部署。
3. 在 Render 环境变量中填写 `DATABASE_URL`，不要提交连接串或数据库密码。应用启动时会在该连接所选数据库/schema 的默认搜索路径中创建三张表。
4. 等待 `/api/config` 健康检查通过后，使用 Render 提供的服务地址访问并注册账户。生产模式不会提供演示账户。

`render.yaml` 没有声明持久磁盘。Render Free Web Service 会在 15 分钟没有入站请求后休眠，并使用临时文件系统；因此云端应使用 Neon 等外部持久 PostgreSQL，而不要把服务目录中的 SQLite 当作可靠存储。Render 会分配一个公开的 `*.onrender.com` 子域名，可先用于课程演示；它不是注册在个人名下的域名。Render 支持绑定自有域名，但域名注册与 DNS 仍需自行处理。Neon 免费计划截至 2026-11-14 的官方说明为每项目每月 100 CU-hours、1 GB 存储；额度及快照/恢复能力可能调整，应以[Render 免费服务文档](https://render.com/docs/free)、[Render 自定义域名文档](https://render.com/docs/custom-domains)和[Neon 免费额度文档](https://neon.com/docs/introduction/provisioned-compute#free-tier)为准。不要把免费额度视作 SLA 或数据库备份方案。

Render 的 `/api/config` 健康检查只返回应用配置，不执行数据库查询；它不能单独证明 Neon 当前可用。`pg` 的 SSL/TLS 配置由连接串参数等驱动配置决定，应用没有单独设置强制 SSL 选项。仓库没有自动备份、恢复演练或数据库连接迁移流程。

## 设计取舍与限制

- **同一套 API 对接两种数据库：** SQLite 适合无需外部服务的本地演示；PostgreSQL 适合部署到临时文件系统之外。适配器减少业务层重复，但数据库 schema、类型和邮箱排序规则仍有差异。
- **行级用户隔离：** 共享 schema，通过绑定当前会话用户 ID 限定流水，部署简单；不是数据库级 RLS，未来新增查询/导出接口必须持续加入所有者过滤。
- **SQLite API 是同步的：** `DatabaseSync` 调用虽然被包装成适配器 Promise，但底层 I/O 仍在 Node 主线程同步执行。对并发较高或持续生产负载不理想；部署选择 PostgreSQL 也避免依赖临时 SQLite 文件。
- **没有 schema migration：** 当前启动逻辑只创建缺失表和索引，不会自动升级已有表结构。未来字段或约束变更需要提供迁移方案，并验证 SQLite 与 PostgreSQL 两种后端。
- **PostgreSQL 占位符转换很轻量：** 适配器通过正则把每个 `?` 替换成 `$n`，不是 SQL 解析器；当前 SQL 参数位点符合该约定，但将来 SQL 字符串字面量或注释中若出现问号，转换可能出错。
- **内存限流有部署边界：** 登录失败计数存在单进程 `Map` 中，扩展多个实例后计数不共享；应用重启会重置计数。
- **列表不分页：** 月度流水接口最多返回 1,000 条，没有游标/偏移分页；超出上限时 UI 无法浏览该月全部记录。CSV 导出不受此列表上限影响。
- **导入导出不是完整迁移/备份：** CSV 只含流水、导入会追加且可能产生重复记录；用户账户和数据库 schema 需要另行管理。
- **账户功能范围有限：** 当前没有邮箱验证、密码重置、账户删除、角色管理或账户数据恢复流程。
- **基础而非完整安全方案：** 没有专门的 CSRF 校验或分布式限流，演示账号凭据公开且只适用于非生产演示；生产环境应使用 HTTPS、持久数据库、最小权限凭据，并另行规划备份与安全审查。

## 主要实现文件

- `package.json`、`pnpm-lock.yaml`：运行时要求、脚本与锁定依赖版本。
- `server/index.js`：进程启动、监听地址与关闭处理。
- `server/app.js`：Express 中间件、认证、API、校验、CSV 与安全响应头。
- `server/database.js`：SQLite/PostgreSQL 适配器、表结构和演示数据。
- `public/index.html`、`public/app.js`、`public/styles.css`：静态页面结构、客户端渲染与响应式样式。
- `.env.example`、`render.yaml`、`README.md`：本机环境变量参考与部署说明。
