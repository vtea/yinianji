#!/bin/bash

# 创建 systemd 服务文件（替代 PM2 的另一种方案）
# 使用此方案可以不依赖 PM2

cat > /etc/systemd/system/chinese-words.service << 'EOF'
[Unit]
Description=Chinese Words Application
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/home/chineseword
Environment="NODE_ENV=production"
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10
StandardOutput=append:/var/log/chinese-words.log
StandardError=append:/var/log/chinese-words-error.log

[Install]
WantedBy=multi-user.target
EOF

echo "systemd 服务文件已创建"
echo ""
echo "使用方法:"
echo "启动: sudo systemctl start chinese-words"
echo "停止: sudo systemctl stop chinese-words"
echo "重启: sudo systemctl restart chinese-words"
echo "启用自启: sudo systemctl enable chinese-words"
echo "查看日志: sudo journalctl -u chinese-words -f"
echo "查看状态: sudo systemctl status chinese-words"
echo ""

# 创建并启动服务
systemctl daemon-reload
systemctl enable chinese-words
systemctl start chinese-words

echo "✅ systemd 服务已启动！"
