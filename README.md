# SQL Log Analyzer Pro

一个支持注册登录、按用户隔离任务与上传文件的 SQL 日志分析 Web 应用。  
前端使用 Vite + React，后端使用 Express，持久化存储已切换为 PostgreSQL。

## 当前架构

- 前端：React + Vite
- 后端：Express API
- 数据库：PostgreSQL
- 上传文件：按用户存放在 `uploads/user-{id}/`
- 认证方式：Bearer Token 会话

## 主要能力

- 注册 / 登录 / 退出
- 按用户隔离 recent、任务记录和聚类结果
- 上传 SQL 日志并执行清洗、聚类、导出
- 支持 UDAL / PostgreSQL 优先解析
- 前后端分离部署

## 本地开发

1. 安装依赖

   ```bash
   npm install
   ```

2. 复制环境变量

   ```bash
   cp .env.example .env
   ```

3. 准备 PostgreSQL 数据库

   ```sql
   CREATE DATABASE sql_log_analyzer;
   ```

4. 一键启动前后端

   ```bash
   npm run start:local
   ```

   默认会固定使用：

   - 前端：`http://127.0.0.1:3000`
   - 后端：`http://127.0.0.1:4399`

5. 如需分开启动，可分别执行

   ```bash
   npm run server
   npm run dev
   ```

6. 打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)

## Docker Compose 一键启动

项目已经提供：

- [docker-compose.yml](/D:/software_test/sql-log-analyzer-pro/docker-compose.yml)
- [Dockerfile.backend](/D:/software_test/sql-log-analyzer-pro/Dockerfile.backend)
- [Dockerfile.frontend](/D:/software_test/sql-log-analyzer-pro/Dockerfile.frontend)
- [docker/nginx/default.conf](/D:/software_test/sql-log-analyzer-pro/docker/nginx/default.conf)

启动方式：

```bash
docker compose up --build
```

启动后默认可访问：

- 前端：[http://127.0.0.1:3000](http://127.0.0.1:3000)
- 后端 API：[http://127.0.0.1:4399](http://127.0.0.1:4399)
- PostgreSQL：`127.0.0.1:5432`

Compose 默认会一起拉起：

- `postgres`
- `backend`
- `frontend`

并且：

- PostgreSQL 数据落在 Docker volume `postgres_data`
- 上传日志落在 Docker volume `uploads_data`
- 前端容器内的 Nginx 会把 `/api/*` 代理到后端容器

## 公网部署

推荐部署组合：

- 前端：Vercel
- 后端 + PostgreSQL：Render

### 1. 部署 Render 后端

仓库已提供 Render Blueprint：

- 文件：[render.yaml](/D:/software_test/sql-log-analyzer-pro/render.yaml)

在 Render 中直接 `New +` -> `Blueprint`，连接 GitHub 仓库后即可创建：

- `sql-log-analyzer-api` Web Service
- `sql-log-analyzer-db` PostgreSQL

当前 Blueprint 已配置：

- `healthCheckPath=/healthz`
- `DATABASE_URL` 自动绑定到 Render PostgreSQL
- `UPLOAD_ROOT=/var/data/uploads`
- 持久盘挂载到 `/var/data`

注意：

- 当前项目会把上传日志保存在服务器磁盘，因此 Render 后端需要持久盘
- 这意味着后端服务应使用支持磁盘的付费方案

### 2. 部署 Vercel 前端

仓库已提供 Vercel 配置：

- 文件：[vercel.json](/D:/software_test/sql-log-analyzer-pro/vercel.json)

在 Vercel 中导入该 GitHub 仓库后，设置环境变量：

```bash
VITE_API_BASE_URL=https://你的-render-backend.onrender.com
```

然后重新部署即可。

### 3. 部署后访问地址

- 前端：Vercel 分配的域名
- 后端 API：Render 分配的域名
- 健康检查：`https://你的-render-backend.onrender.com/healthz`

## 前后端分离部署

- 前端通过 `VITE_API_BASE_URL` 指向后端 API
- 本地开发未显式设置 `VITE_API_BASE_URL` 时，Vite 会继续通过 `/api` 代理转发到本地 Express
- 后端通过 `DATABASE_URL` 连接 PostgreSQL
- 后端端口由 `SERVER_PORT` 控制，未设置时会回退到 `.server-port` 或 `4399`
- 上传目录可通过 `UPLOAD_ROOT` 指定

示例：

```bash
VITE_API_BASE_URL=https://api.example.com
SERVER_PORT=4399
SERVER_HOST=0.0.0.0
SESSION_TTL_DAYS=14
UPLOAD_ROOT=./uploads
DATABASE_URL=postgres://app_user:app_password@db.example.com:5432/sql_log_analyzer
POSTGRES_DB=sql_log_analyzer
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_PORT=5432
BACKEND_PORT=4399
FRONTEND_PORT=3000
```

## 数据存储位置

- 任务、会话、recent、聚类结果：PostgreSQL
- 用户上传文件：`uploads/user-{id}/`

## 验证命令

```bash
npm run lint
npm run build
npm run test:parser
npm run test:e2e
```

## GitHub Actions

仓库已提供 CI 工作流：

- 文件：[.github/workflows/ci.yml](/D:/software_test/sql-log-analyzer-pro/.github/workflows/ci.yml)
- 覆盖内容：`lint`、`build`、`test:parser`、`test:e2e`
- CI 会在 GitHub Actions 中自动拉起 PostgreSQL 17 服务

## 当前仍建议继续补强的点

- 把上传文件换成对象存储
- 增加邀请码 / 邮箱验证 / 密码找回
- 为公开部署补反向代理、限流、审计和清理策略
