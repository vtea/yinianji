# 开发与部署指南

## 本地开发环境

### 环境要求
- Node.js 18.x（推荐使用 nvm 管理版本）
- npm 或 yarn

### 快速启动

1. **安装依赖**
   ```bash
   npm install
   ```

2. **启动开发服务器**
   ```bash
   npm start
   # 或
   node server.js
   ```

3. **访问应用**
   - 打开浏览器访问：http://localhost:3000

### 常见问题

#### sqlite3 模块加载错误

如果遇到 `Error: dlopen ... slice is not valid mach-o file` 错误：

```bash
# 清理并重新安装依赖
rm -rf node_modules package-lock.json
npm install

# 或者只重新编译 sqlite3
npm rebuild sqlite3
```

**原因**：sqlite3 是 native 模块，需要针对当前 Node.js 版本和操作系统编译。

#### Node.js 版本不匹配

项目要求 Node.js 18.x，如果使用其他版本可能会有兼容性问题。

**推荐使用 nvm 管理 Node.js 版本：**

```bash
# 安装 nvm（如果还没有）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# 安装并使用 Node.js 18
nvm install 18
nvm use 18

# 设置为默认版本
nvm alias default 18
```

---

## Docker 部署

### Docker 配置说明

#### Dockerfile
- 基础镜像：`node:18-alpine`
- 安装了 Python 和构建工具（sqlite3 编译所需）
- 使用生产环境依赖
- 暴露端口：3000

#### docker-compose.yml
- 端口映射：3000:3000
- 数据库文件挂载：`./words.db:/app/words.db`（持久化数据）
- 自动重启：`unless-stopped`

### 构建和运行

1. **构建镜像**
   ```bash
   docker build -t yinianji-app .
   ```

2. **使用 docker-compose 运行**
   ```bash
   # 启动服务
   docker-compose up -d

   # 查看日志
   docker-compose logs -f

   # 停止服务
   docker-compose down
   ```

3. **单独运行容器**
   ```bash
   docker run -d \
     -p 3000:3000 \
     -v $(pwd)/words.db:/app/words.db \
     --name yinianji \
     yinianji-app
   ```

### 验证部署

```bash
# 检查容器是否运行
docker ps

# 查看容器日志
docker logs yinianji

# 测试接口
curl http://localhost:3000
```

### Docker 构建优化建议

1. **.dockerignore 文件**：已添加，避免将本地 node_modules 复制到镜像中

2. **多阶段构建**（可选优化）：
   如果需要更小的镜像，可以使用多阶段构建：
   ```dockerfile
   # 构建阶段
   FROM node:18-alpine as builder
   RUN apk add --no-cache python3 make g++
   WORKDIR /app
   COPY package*.json ./
   RUN npm install --production

   # 运行阶段
   FROM node:18-alpine
   WORKDIR /app
   COPY --from=builder /app/node_modules ./node_modules
   COPY . .
   EXPOSE 3000
   CMD ["node", "server.js"]
   ```

---

## 生产环境部署

参考以下文件：
- `DEPLOY.md` - 服务器部署指南
- `server-deploy-guide.md` - 服务器配置指南
- `deploy.sh` - 自动化部署脚本
- `docker-deploy-complete.sh` - Docker 完整部署脚本
- `ssl-setup.sh` - SSL 证书配置
- `systemd-service.sh` - Systemd 服务配置

---

## 项目结构

```
yinianji-1/
├── public/              # 前端静态文件
│   ├── index.html       # 主页（生字管理）
│   ├── pinyin.html      # 拼音学习
│   ├── english.html     # 英语学习
│   ├── chinese.html     # 汉字学习
│   ├── vocabulary.html  # 词汇管理
│   └── ai-tutor.html    # AI 辅导
├── server.js            # Express 后端服务器
├── words.db             # SQLite 数据库（自动创建）
├── package.json         # 项目依赖
├── Dockerfile           # Docker 构建文件
├── docker-compose.yml   # Docker Compose 配置
└── .dockerignore        # Docker 构建忽略文件
```

---

## API 端口

默认端口：3000

可通过环境变量修改：
```bash
PORT=8080 node server.js
```

或在 docker-compose.yml 中修改：
```yaml
environment:
  - PORT=8080
ports:
  - "8080:8080"
```

---

## 数据库

项目使用 SQLite 数据库，数据文件：`words.db`

**注意**：
- 本地开发时，数据库会自动创建在项目根目录
- Docker 部署时，使用 volume 挂载确保数据持久化
- 数据库表会在首次启动时自动初始化

### 数据库表结构
- `users` - 用户表
- `words` - 生字表
- `pinyin_learn` - 拼音学习记录
- `english_learn` - 英语学习记录
- `english_new_words` - 英语单词本
- `ai_chat_history` - AI 对话历史

---

## 开发建议

1. **使用正确的 Node.js 版本**：推荐使用 nvm 管理版本
2. **定期备份数据库**：`words.db` 文件包含所有用户数据
3. **环境变量**：敏感配置（如 API Key）应使用环境变量
4. **CORS 配置**：已启用，如需限制来源可在 server.js 中修改
