#!/bin/bash

# Docker 数据迁移脚本
# 将现有的 bind mount 数据库迁移到 Docker volume
# 使用方法: ./docker-migrate-data.sh

set -e

echo "========================================="
echo "Docker 数据迁移脚本"
echo "========================================="
echo "此脚本将帮助您将数据库从 bind mount 迁移到 Docker volume"
echo ""

# 检查是否有本地数据库文件
if [ ! -f "./words.db" ]; then
    echo "⚠️  未找到本地数据库文件 ./words.db"
    echo "如果数据库已经在 volume 中，可以跳过此步骤"
    read -p "是否继续？(y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 0
    fi
fi

# 1. 停止容器
echo "[1/4] 停止现有容器..."
docker-compose down 2>/dev/null || true
echo "✓ 容器已停止"

# 2. 创建 volume（如果不存在）
echo "[2/4] 创建 Docker volume..."
docker volume create yinianji-1_db_data 2>/dev/null || echo "Volume 已存在"

# 3. 如果有本地数据库文件，复制到 volume
if [ -f "./words.db" ]; then
    echo "[3/4] 迁移数据库到 volume..."
    
    # 创建临时容器来复制数据
    docker run --rm \
        -v "$(pwd)/words.db:/source/words.db:ro" \
        -v yinianji-1_db_data:/data \
        alpine sh -c "cp /source/words.db /data/words.db && chmod 666 /data/words.db"
    
    echo "✓ 数据库已迁移到 volume"
    
    # 备份原文件
    BACKUP_DIR="./backups"
    mkdir -p "$BACKUP_DIR"
    BACKUP_FILE="$BACKUP_DIR/words.db.backup.$(date +%Y%m%d_%H%M%S)"
    cp ./words.db "$BACKUP_FILE"
    echo "✓ 原数据库已备份到: $BACKUP_FILE"
    
    read -p "是否删除本地数据库文件？(数据已在 volume 中) (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        mv ./words.db "./words.db.migrated.$(date +%Y%m%d_%H%M%S)"
        echo "✓ 本地文件已重命名（保留备份）"
    fi
else
    echo "[3/4] 跳过数据库迁移（未找到本地文件）"
fi

# 4. 启动容器
echo "[4/4] 启动容器..."
docker-compose up -d
echo "✓ 容器已启动"

echo ""
echo "========================================="
echo "✅ 迁移完成！"
echo "========================================="
echo ""
echo "数据库位置:"
echo "  Docker Volume: yinianji-1_db_data"
echo ""
echo "查看 volume 信息:"
echo "  docker volume inspect yinianji-1_db_data"
echo ""
echo "备份 volume 数据:"
echo "  docker run --rm -v yinianji-1_db_data:/data -v \$(pwd)/backups:/backup alpine tar czf /backup/db-backup-\$(date +%Y%m%d).tar.gz -C /data ."
echo ""
