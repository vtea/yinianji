# 部署指南

## 选项 1: Railway.app（推荐，最简单）

### 步骤：
1. 注册账号：https://railway.app
2. 连接 GitHub 仓库或直接上传代码
3. Railway 会自动检测 Dockerfile 并部署
4. 设置环境变量：
   - `PORT`: 3000 (可选，默认会自动设置)
   - `DB_PATH`: /data/words.db

### 优点：
- 完全免费
- 自动部署
- 支持持久化存储
- 国内访问速度可以

---

## 选项 2: Render.com

### 步骤：
1. 注册：https://render.com
2. 创建新的 Web Service
3. 连接 GitHub 仓库
4. 构建命令：`npm install`
5. 启动命令：`npm start`

---

## 选项 3: Heroku（需要付费）

### 步骤：
```bash
# 安装 Heroku CLI
# 登录
heroku login

# 创建应用
heroku create chinese-words

# 推送代码
git push heroku main

# 查看日志
heroku logs --tail
```

---

## 选项 4: 腾讯云 / 阿里云 / 华为云

### 使用 Docker 部署：
```bash
# 1. 构建 Docker 镜像
docker build -t chinese-words .

# 2. 上传到云平台的容器仓库
# 3. 创建云主机并运行容器
docker run -p 3000:3000 -e DB_PATH=/data/words.db chinese-words
```

---

## 选项 5: 自己的服务器（VPS）

### 步骤：
```bash
# 1. SSH 登录服务器
ssh root@your_server_ip

# 2. 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. 克隆项目
git clone your_repo_url
cd Chineseword

# 4. 安装依赖
npm install

# 5. 使用 PM2 来管理进程
npm install -g pm2
pm2 start server.js --name "chinese-words"
pm2 startup
pm2 save

# 6. 使用 Nginx 反向代理（可选）
# 配置 Nginx 将请求转发到 localhost:3000
```

---

## 本地测试 Docker 部署

```bash
# 构建镜像
docker build -t chinese-words .

# 运行容器
docker run -p 3000:3000 chinese-words

# 访问 http://localhost:3000
```

---

## 常见问题

### Q: 数据库会丢失吗？
A: 使用 SQLite 的应用需要持久化存储。大多数云平台都支持。建议定期备份。

### Q: 如何添加域名？
A: 购买域名后配置 DNS 指向你的应用服务器。

### Q: 如何处理 HTTPS？
A: 大多数云平台自动提供免费的 Let's Encrypt 证书。如果是自己的服务器，可以用 Certbot。
