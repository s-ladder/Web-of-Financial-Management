# Web-of-Financial-Management

Web编程大作业——收入支出记账网页

## 分寸 · 个人生活账本

一个基于 Node.js 和 Express 的中文个人记账网站。前端使用原生 HTML、CSS 和 JavaScript；本地数据默认写入 SQLite，部署时可切换到 PostgreSQL。

技术选型、架构、数据模型、API、安全边界和部署说明见[技术栈文档](docs/TECH_STACK.md)。

## 本机运行

需要 Node.js 22.13 或更高版本和 pnpm。

```powershell
pnpm install
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。本地首次启动会创建 `data/ledger.sqlite` 和可选演示账本。若连接 Neon，可使用 Neon CLI 将变量拉取到 `.env.local`；启动时会自动加载 `.env.local`（其次为 `.env`）。这些本地密钥文件不会提交到 Git，Render 也不会读取它们，生产环境须在 Render 环境变量中单独设置 `DATABASE_URL`。演示模式只在非生产环境开放：

- 邮箱：`demo@fencun.local`
- 密码：`Fencun2026!`

也可以创建自己的账户。用户密码使用随机盐和 scrypt 哈希保存；账目、会话和统计数据均按用户隔离。金额以整数分保存，不使用浮点数累计。会话令牌用 SHA-256 哈希保存在数据库中，因此服务器重启后仍能继续登录。生产模式默认禁用演示账户，并为会话 Cookie 添加 `Secure` 属性。

## 功能

- 收支总览、六个月趋势、分类占比和最近流水
- 独立数据分析页：支出环比、有消费日均、结余率、消费天数、逐日支出、月度对照、完整分类构成和最大单笔支出
- 登录欢迎区的本地化风景照片；页面数据图表使用原生 SVG 与 CSS，无图表库依赖
- 按月份浏览、按收入或支出筛选、按分类或备注搜索
- 新增、编辑、删除收入和支出记录
- CSV 导入、UTF-8 CSV 导出和可下载的导入模板
- 多用户注册、登录、退出与服务器端会话
- SQLite 本地持久化、PostgreSQL 云端持久化
- 基础安全响应头、输入验证、登录失败限速和 1,000 行 CSV 导入上限

CSV 表头为 `date,type,category,amount,note`。日期使用 `YYYY-MM-DD`；`type` 为 `expense` 或 `income`，也接受“支出”或“收入”；金额最多保留两位小数。分类须为页面中提供的分类。

## 免费上云和网址

项目附带 [Render Blueprint](render.yaml)。它会建立一个免费的 Render Web Service，服务获得一个公开的 `*.onrender.com` 网址，无须先购买自定义域名。这个网址是免费子域名，不是已注册在个人名下的自定义域名。

**先为数据库准备一个 Neon 项目，再部署应用。** Render Free 服务连续 15 分钟没有入站流量后会休眠；下次访问需要冷启动。文件系统是临时的，重启、部署或休眠都会丢失 SQLite 文件，因此云端必须连接 Neon PostgreSQL，不能依赖服务目录中的 SQLite。Neon Free 的存储、计算和流量额度会调整，部署前请核对[Render 免费服务说明](https://render.com/docs/free)和[Neon 免费额度说明](https://neon.com/docs/introduction/provisioned-compute#free-tier)。免费托管用于课程展示和原型验证，不应作为重要财务数据的唯一存档；请定期导出 CSV 并单独保存备份。

1. 创建 GitHub 仓库，将本项目推送到 `main` 分支。
2. 在 Neon 创建一个 Free PostgreSQL 项目，复制其连接字符串。使用服务商推荐的连接串，并保管好密码；不要将它提交到仓库。
3. 在 Render 选择 **New → Blueprint** 并连接该 GitHub 仓库。Render 会读取 `render.yaml`；按提示将 Neon 连接字符串填入 `DATABASE_URL`，确认使用 Free 实例后创建部署。
4. 部署完成后，用 Render 显示的 `onrender.com` 网址打开网站。生产模式不提供公共演示账号，请注册自己的账号。

Render 自动分配的 `onrender.com` 子域名可用于课堂演示；它不是注册到你名下的个人域名。后续如要绑定自己的域名，须另行注册域名并设置 DNS。公开部署前应先使用演示数据检查页面与导入导出，不要上传真实财务信息；数据库免费项目也应另行安排备份。

## API 概览

- `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`
- `GET /api/session`、`GET /api/config`、`GET /api/categories`
- `GET /api/dashboard?month=YYYY-MM`
- `GET /api/transactions?month=YYYY-MM&kind=expense&q=餐饮`
- `POST /api/transactions`、`PUT /api/transactions/:id`、`DELETE /api/transactions/:id`
- `GET /api/export.csv`、`POST /api/import.csv`

账目新增、修改、删除和导入接口都从已登录会话读取用户 ID，不接受客户端指定的所有者 ID。

导出 CSV 时，备注如果以 `=`, `+`, `-`, `@` 或控制字符开头，会加上文本前缀，避免电子表格把备注当成公式执行。

## 测试

```powershell
pnpm test
```
