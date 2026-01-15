#!/bin/bash

# Let's Encrypt SSL 证书配置脚本
# 使用方法: bash ssl-setup.sh your-domain.com

DOMAIN=$1

if [ -z "$DOMAIN" ]; then
    echo "使用方法: bash ssl-setup.sh your-domain.com"
    exit 1
fi

echo "========================================="
echo "配置 SSL 证书"
echo "域名: $DOMAIN"
echo "========================================="

# 1. 安装 Certbot
echo "[1/4] 安装 Certbot..."
apt-get update
apt-get install -y certbot python3-certbot-nginx

# 2. 获取证书
echo "[2/4] 获取 Let's Encrypt 证书..."
certbot certonly --nginx -d $DOMAIN -d www.$DOMAIN --agree-tos --no-eff-email -m admin@$DOMAIN

# 3. 更新 Nginx 配置
echo "[3/4] 更新 Nginx 配置..."
cat > /etc/nginx/sites-available/chinese-words << EOF
upstream chinese_words_app {
    server 127.0.0.1:3000;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN www.$DOMAIN;

    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    client_max_body_size 10M;
    access_log /var/log/nginx/chinese-words-access.log;
    error_log /var/log/nginx/chinese-words-error.log;

    location / {
        proxy_pass http://chinese_words_app;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    return 301 https://\$server_name\$request_uri;
}
EOF

# 4. 测试和重启 Nginx
echo "[4/4] 重启 Nginx..."
nginx -t
systemctl restart nginx

# 5. 设置证书自动更新
echo ""
echo "配置证书自动更新..."
certbot renew --dry-run

# 创建 cron 任务
cat > /etc/cron.d/certbot-renewal << 'EOF'
# Let's Encrypt 证书自动更新
0 2 * * * root certbot renew --quiet --no-eff-email --post-hook "systemctl reload nginx"
EOF

echo ""
echo "========================================="
echo "✅ SSL 证书配置完成！"
echo "========================================="
echo ""
echo "你的网站现在支持 HTTPS！"
echo "访问地址: https://$DOMAIN"
echo ""
echo "证书信息:"
echo "- 过期时间: certbot certificates"
echo "- 自动更新: 每天凌晨 2 点"
echo "- 证书路径: /etc/letsencrypt/live/$DOMAIN/"
echo ""
