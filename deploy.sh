#!/bin/bash

# 自己服务器部署脚本
# 使用方法：ssh root@your_server_ip < deploy.sh

set -e

echo "========================================="
echo "开始部署 Chinese Words 应用"
echo "========================================="

# 1. 更新系统
echo "[1/7] 更新系统..."
apt-get update
apt-get upgrade -y

# 2. 安装 Node.js 18.x
echo "[2/7] 安装 Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    apt-get install -y nodejs
else
    echo "Node.js 已安装"
fi

# 3. 安装 PM2
echo "[3/7] 安装 PM2..."
npm install -g pm2

# 4. 克隆项目
echo "[4/7] 克隆项目..."
cd /home
if [ ! -d "chineseword" ]; then
    git clone https://github.com/your-username/chineseword.git
    cd chineseword
else
    cd chineseword
    git pull
fi

# 5. 安装项目依赖
echo "[5/7] 安装项目依赖..."
npm install --production

# 6. 启动应用
echo "[6/7] 启动应用..."
pm2 delete "chinese-words" 2>/dev/null || true
pm2 start server.js --name "chinese-words" --env "production"
pm2 startup
pm2 save

# 7. 配置 Nginx（如果安装）
echo "[7/7] 检查 Nginx..."
if command -v nginx &> /dev/null; then
    echo "Nginx 已安装"
else
    echo "安装 Nginx..."
    apt-get install -y nginx
    systemctl start nginx
    systemctl enable nginx
fi

echo "========================================="
echo "✅ 部署完成！"
echo "========================================="
echo ""
echo "应用信息："
echo "- PM2 进程名: chinese-words"
echo "- 本地端口: 3000"
echo "- 日志: pm2 logs chinese-words"
echo "- 重启: pm2 restart chinese-words"
echo "- 停止: pm2 stop chinese-words"
echo ""
echo "下一步："
echo "1. 配置 Nginx（参考 nginx.conf）"
echo "2. 配置 SSL 证书（参考 ssl-setup.sh）"
echo "3. 开放防火墙端口: sudo ufw allow 80,443/tcp"
echo ""
