#!/bin/bash

# 服务器部署完成脚本
# 在 Docker 容器运行的基础上完成 Nginx 配置

echo "========================================="
echo "完成服务器部署配置"
echo "========================================="

# 1. 安装 Nginx（如果未安装）
echo "[1/5] 检查 Nginx..."
if ! command -v nginx &> /dev/null; then
    apt-get update
    apt-get install -y nginx
else
    echo "✓ Nginx 已安装"
fi

# 2. 启动 Nginx
echo "[2/5] 启动 Nginx..."
systemctl start nginx
systemctl enable nginx

# 3. 配置 Nginx 反向代理
echo "[3/5] 配置 Nginx..."
cat > /etc/nginx/sites-available/chinese-words << 'EOF'
upstream chinese_words_app {
    server 127.0.0.1:9123;
}

server {
    listen 80;
    listen [::]:80;
    server_name _;

    client_max_body_size 10M;
    access_log /var/log/nginx/chinese-words-access.log;
    error_log /var/log/nginx/chinese-words-error.log;

    location / {
        proxy_pass http://chinese_words_app;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
EOF

# 4. 启用配置
echo "[4/5] 启用 Nginx 配置..."
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/chinese-words /etc/nginx/sites-enabled/

# 测试配置
nginx -t

# 5. 重启 Nginx
echo "[5/5] 重启 Nginx..."
systemctl restart nginx

# 创建持久化数据目录
mkdir -p /data
chmod 755 /data

echo ""
echo "========================================="
echo "✅ 部署完成！"
echo "========================================="
echo ""
echo "应用已在线运行！"
echo ""
echo "访问地址:"
echo "- 直接访问服务器 IP: http://your-server-ip"
echo "- 直接访问端口: http://your-server-ip:9123"
echo ""
echo "Docker 容器:"
echo "- 查看容器: docker ps"
echo "- 查看日志: docker logs <container-id>"
echo "- 停止容器: docker stop <container-id>"
echo "- 重启容器: docker restart <container-id>"
echo ""
echo "Nginx:"
echo "- 查看日志: tail -f /var/log/nginx/chinese-words-access.log"
echo "- 查看错误: tail -f /var/log/nginx/chinese-words-error.log"
echo "- 重启: systemctl restart nginx"
echo ""
echo "下一步:"
echo "1. 配置域名指向此服务器（如果有域名）"
echo "2. 配置 HTTPS: bash ssl-setup.sh your-domain.com"
echo ""
