#!/bin/bash

# Docker 数据库备份脚本
# 使用方法: ./docker-backup-db.sh

set -e

BACKUP_DIR="./backups"
mkdir -p "$BACKUP_DIR"

echo "========================================="
echo "数据库备份脚本"
echo "========================================="

# 检查 volume 是否存在
if ! docker volume ls | grep -q "yinianji-1_db_data"; then
    echo "⚠️  Volume 'yinianji-1_db_data' 不存在"
    echo "如果使用 bind mount，请手动备份 ./words.db"
    exit 1
fi

# 备份数据库
BACKUP_FILE="$BACKUP_DIR/db-backup-$(date +%Y%m%d_%H%M%S).tar.gz"

echo "[1/2] 备份数据库到 volume..."
docker run --rm \
  -v yinianji-1_db_data:/data \
  -v "$(pwd)/$BACKUP_DIR:/backup" \
  alpine tar czf "/backup/$(basename $BACKUP_FILE)" -C /data .

if [ $? -eq 0 ]; then
    echo "✓ 备份完成: $BACKUP_FILE"
    
    # 保留最近 30 天的备份
    echo "[2/2] 清理旧备份（保留30天）..."
    find "$BACKUP_DIR" -name "db-backup-*.tar.gz" -mtime +30 -delete
    echo "✓ 清理完成"
    
    echo ""
    echo "备份文件:"
    ls -lh "$BACKUP_FILE"
    echo ""
    echo "所有备份:"
    ls -lh "$BACKUP_DIR"/db-backup-*.tar.gz 2>/dev/null | tail -5
else
    echo "❌ 备份失败"
    exit 1
fi
