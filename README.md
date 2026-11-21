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

- 收支总览、可切换月度/逐日的收支趋势、分类占比和最近流水
- 独立数据分析页：支出环比、有消费日均、结余率、消费天数、逐日支出、月度对照、完整分类构成和最大单笔支出
- 登录欢迎区的本地化风景照片；页面数据图表使用原生 SVG 与 CSS，无图表库依赖
- 记录日期、时分秒、地点、项目和具体内容；学生新增记录时地点预填“学校”，也可清空或修改
- 按月份浏览、按收入或支出筛选、按分类、项目、内容或地点搜索
- 新增、编辑、删除收入和支出记录
- CSV 导入、UTF-8 CSV 导出和可下载的导入模板
- 多用户注册、登录、退出与服务器端会话
- 注册时选择学生、上班族或家庭记账身份，按身份展示相应的收入与支出分类
- 家庭组创建与邀请码加入；家庭成员可共同记录、导入导出并查看家庭汇总
- 个人账本与家庭账本分开统计；家庭明细显示记录人，成员可退出家庭组
- SQLite 本地持久化、PostgreSQL 云端持久化
- 基础安全响应头、输入验证、登录失败限速和 1,000 行 CSV 导入上限

CSV 模板表头为 `date,time,type,category,amount,location,project,content`，其中 `date`、`type`、`category`、`amount` 必填；其他列可留空。“项目”描述场景（例如“午饭，外卖”），“内容”描述具体物品（例如“土豆牛肉盖浇饭”）。旧版 `note` / “备注”列会导入到“项目”；数据库迁移也会把现有备注复制到项目，不删除旧字段。学生新增记录时地点预填“学校”，也可清空或修改；兼容旧接口及不含地点列的旧版 CSV 时，会为学生补上“学校”。示例文件：[`docs/import-example.csv`](docs/import-example.csv)；页面的“下载 CSV 模板”会生成当天日期的模板。

## 免费上云和网址

项目附带 [Render Blueprint](render.yaml)。它会建立一个免费的 Render Web Service，服务获得一个公开的 `*.onrender.com` 网址，无须先购买自定义域名。这个网址是免费子域名，不是已注册在个人名下的自定义域名。

当前 Blueprint 使用 Render 的 Node runtime 直接运行 Express，没有在项目中安装或启动 NGINX；网站页面与 API 由同一个 Express 服务提供。对当前单服务部署不需要额外增加 NGINX。

**先为数据库准备一个 Neon 项目，再部署应用。** Render Free 服务连续 15 分钟没有入站流量后会休眠；下次访问需要冷启动。文件系统是临时的，重启、部署或休眠都会丢失 SQLite 文件，因此云端必须连接 Neon PostgreSQL，不能依赖服务目录中的 SQLite。Neon Free 的存储、计算和流量额度会调整，部署前请核对[Render 免费服务说明](https://render.com/docs/free)和[Neon 免费额度说明](https://neon.com/docs/introduction/provisioned-compute#free-tier)。免费托管用于课程展示和原型验证，不应作为重要财务数据的唯一存档；请定期导出 CSV 并单独保存备份。

1. 创建 GitHub 仓库，将本项目推送到 `main` 分支。
2. 在 Neon 创建一个 Free PostgreSQL 项目，复制其连接字符串。使用服务商推荐的连接串，并保管好密码；不要将它提交到仓库。
3. 在 Render 选择 **New → Blueprint** 并连接该 GitHub 仓库。Render 会读取 `render.yaml`；按提示将 Neon 连接字符串填入 `DATABASE_URL`，确认使用 Free 实例后创建部署。
4. 部署完成后，用 Render 显示的 `onrender.com` 网址打开网站。生产模式不提供公共演示账号，请注册自己的账号。

Render 自动分配的 `onrender.com` 子域名可用于课堂演示；它不是注册到你名下的个人域名。后续如要绑定自己的域名，须另行注册域名并设置 DNS。公开部署前应先使用演示数据检查页面与导入导出，不要上传真实财务信息；数据库免费项目也应另行安排备份。

## API 概览

- `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`
- `GET /api/session`、`GET /api/config`、`GET /api/categories`
- `POST /api/household`、`POST /api/household/join`、`GET /api/household`、`DELETE /api/household/leave`
- `POST /api/household/invite-code`（创建者更换邀请码）、`DELETE /api/household/members/:userId`（创建者移除成员）
- `GET /api/dashboard?month=YYYY-MM&scope=personal|household`
- `GET /api/transactions?month=YYYY-MM&kind=expense&q=餐饮&scope=personal|household`
- `POST /api/transactions`、`PUT /api/transactions/:id`、`DELETE /api/transactions/:id`
- `GET /api/export.csv`、`POST /api/import.csv`

账目新增、修改、删除和导入接口都从已登录会话读取用户 ID，不接受客户端指定的所有者 ID。个人账本只查询 `household_id IS NULL` 的个人流水；家庭账本只查询当前账户所属家庭组的流水。家庭成员均可管理共享流水，明细会显示记录人。每个账户当前最多加入一个家庭组；创建者不能直接退出，但可以更换邀请码和移除成员，其他成员可以退出。邀请码没有过期时间，只能由创建者主动更换，请仅分享给可信任的家人。

导出 CSV 时，项目、内容等如果以 `=`, `+`, `-`, `@` 或控制字符开头，会加上文本前缀，避免电子表格把它当成公式执行。

## 测试

```powershell
pnpm test
```
