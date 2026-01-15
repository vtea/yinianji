# 自己服务器部署指南

## 前置要求

- 一台 Linux 服务器（推荐 Ubuntu 20.04 或更高版本）
- SSH 访问权限
- 一个域名（可选，也可以用 IP 直接访问）

## 快速部署（自动脚本）

### 方式 1: 一键部署脚本

```bash
# 在本地运行，自动配置服务器
ssh root@your_server_ip < deploy.sh
```

这个脚本会自动：
- 更新系统
- 安装 Node.js 18.x
- 安装 PM2 进程管理工具
- 克隆项目代码
- 安装依赖
- 启动应用
- 安装 Nginx

### 方式 2: 手动部署（推荐新手）

#### 第 1 步：连接服务器

```bash
ssh root@your_server_ip
# 或
ssh -i /path/to/key.pem ubuntu@your_server_ip
```

#### 第 2 步：更新系统

```bash
apt-get update
apt-get upgrade -y
```

#### 第 3 步：安装 Node.js

```bash
# 添加 Node 官方源
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -

# 安装 Node.js
apt-get install -y nodejs
```

验证安装：
```bash
node --version
npm --version
```

#### 第 4 步：克隆项目

```bash
# 进入项目目录
cd /home
git clone https://github.com/your-username/chineseword.git
cd chineseword

# 或者如果没有 git，直接上传文件
```

#### 第 5 步：安装依赖

```bash
npm install --production
```

#### 第 6 步：安装 PM2（进程管理工具）

```bash
npm install -g pm2
```

#### 第 7 步：启动应用

```bash
# 启动应用
pm2 start server.js --name "chinese-words"

# 设置开机自启
pm2 startup
pm2 save

# 查看运行状态
pm2 status
pm2 logs chinese-words
```

#### 第 8 步：安装 Nginx（反向代理）

```bash
apt-get install -y nginx
systemctl start nginx
systemctl enable nginx
```

#### 第 9 步：配置 Nginx

复制 `nginx.conf` 的内容到服务器：

```bash
# 编辑 Nginx 配置
sudo nano /etc/nginx/sites-available/chinese-words

# 粘贴 nginx.conf 中的内容，将 your-domain.com 改成你的域名

# 创建软链接启用此配置
sudo ln -s /etc/nginx/sites-available/chinese-words /etc/nginx/sites-enabled/

# 删除默认配置
sudo rm /etc/nginx/sites-enabled/default

# 测试 Nginx 配置
sudo nginx -t

# 重启 Nginx
sudo systemctl restart nginx
```

#### 第 10 步：开放防火墙

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

## 配置 HTTPS（SSL 证书）

### 使用 Let's Encrypt 免费证书

```bash
# 上传 ssl-setup.sh 到服务器，然后运行
bash ssl-setup.sh your-domain.com
```

或手动配置：

```bash
# 安装 Certbot
apt-get install -y certbot python3-certbot-nginx

# 获取证书
certbot certonly --nginx -d your-domain.com -d www.your-domain.com

# 证书会保存在 /etc/letsencrypt/live/your-domain.com/
```

## 常用 PM2 命令

```bash
# 查看应用状态
pm2 status

# 查看日志
pm2 logs chinese-words

# 查看实时日志
pm2 logs chinese-words --lines 100 --follow

# 重启应用
pm2 restart chinese-words

# 停止应用
pm2 stop chinese-words

# 删除应用
pm2 delete chinese-words

# 查看进程详情
pm2 show chinese-words

# 监控资源使用
pm2 monit
```

## 常用 Nginx 命令

```bash
# 测试配置
sudo nginx -t

# 启动
sudo systemctl start nginx

# 停止
sudo systemctl stop nginx

# 重启
sudo systemctl restart nginx

# 查看状态
sudo systemctl status nginx

# 查看日志
sudo tail -f /var/log/nginx/chinese-words-access.log
sudo tail -f /var/log/nginx/chinese-words-error.log
```

## 数据备份

### 定期备份数据库

```bash
# 创建备份脚本
cat > /home/backup-db.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/home/chineseword/backups"
mkdir -p $BACKUP_DIR
cp /home/chineseword/words.db $BACKUP_DIR/words.db.$(date +%Y%m%d_%H%M%S)

# 保留最近 30 天的备份
find $BACKUP_DIR -name "words.db.*" -mtime +30 -delete
EOF

chmod +x /home/backup-db.sh

# 添加定时任务（每天凌晨 3 点备份）
crontab -e
# 添加这一行:
# 0 3 * * * /home/backup-db.sh
```

## 监控和日志

### 查看应用日志

```bash
# PM2 日志
pm2 logs chinese-words

# Nginx 访问日志
tail -f /var/log/nginx/chinese-words-access.log

# Nginx 错误日志
tail -f /var/log/nginx/chinese-words-error.log
```

### 系统监控

```bash
# 查看 CPU 和内存使用
pm2 monit

# 或使用 htop
apt-get install -y htop
htop
```

## 故障排查

### 应用无法启动

```bash
# 检查日志
pm2 logs chinese-words

# 确保端口 3000 没有被占用
netstat -tlnp | grep 3000

# 查看进程
ps aux | grep node
```

### Nginx 502 Bad Gateway

```bash
# 检查应用是否运行
pm2 status

# 检查 Nginx 配置
sudo nginx -t

# 查看 Nginx 错误日志
sudo tail -f /var/log/nginx/chinese-words-error.log
```

### 数据库错误

```bash
# 检查数据库文件权限
ls -la /home/chineseword/words.db

# 如果权限不对，修改为
sudo chown www-data:www-data /home/chineseword/words.db
sudo chmod 644 /home/chineseword/words.db
```

## 更新应用

```bash
# 进入项目目录
cd /home/chineseword

# 拉取最新代码
git pull

# 重新安装依赖（如果有变化）
npm install --production

# 重启应用
pm2 restart chinese-words
```

## 性能优化

### 启用 Gzip 压缩

在 `/etc/nginx/nginx.http` 中添加：

```nginx
gzip on;
gzip_types text/plain text/css text/javascript application/json;
gzip_min_length 1000;
gzip_comp_level 6;
```

### 增加 Node.js 进程数量

使用 `pm2 cluster` 模式：

```bash
pm2 start server.js --name "chinese-words" -i 4
```

## 常见问题

**Q: 如何访问应用？**
A: 
- 如果有域名：https://your-domain.com
- 如果没有域名：http://your-server-ip
- 直接访问端口：http://your-server-ip:3000

**Q: 数据会丢失吗？**
A: SQLite 数据保存在 words.db 文件中，定期备份即可。

**Q: 如何修改删除密码？**
A: 在 server.js 中修改 `DELETE_PASSWORD` 变量。

**Q: 服务器流量很大，如何扩展？**
A: 
- 启用 PM2 cluster 模式
- 使用 Redis 缓存
- 使用 CDN 加速静态资源

## 获取帮助

如遇问题，查看以下日志：
1. 应用日志: `pm2 logs chinese-words`
2. Nginx 日志: `/var/log/nginx/chinese-words-error.log`
3. 系统日志: `journalctl -xe`
