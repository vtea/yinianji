# 使用官方Node镜像作为基础镜像
FROM node:18-alpine

# 安装 Python 和构建工具（sqlite3 需要）
RUN apk add --no-cache python3 make g++

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（如果有）
COPY package*.json ./

# 安装依赖（包含构建工具，确保 sqlite3 正确编译）
RUN npm install --production

# 复制项目所有文件到容器
COPY . .

# 暴露服务器端口（根据你server.js监听端口修改，默认3000）
EXPOSE 3000

# 启动命令
CMD ["node", "server.js"]
