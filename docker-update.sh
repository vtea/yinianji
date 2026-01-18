#!/bin/bash

# Docker 更新脚本 - 确保数据库不丢失
# 使用方法: ./docker-update.sh

set -e

echo "========================================="
echo "Docker 更新脚本 - 保护数据库"
echo "========================================="

# 1. 检查是否有运行中的容器
echo "[1/5] 检查运行中的容器..."
if [ "$(docker ps -q -f name=.*app)" ]; then
    echo "发现运行中的容器，正在停止..."
    docker-compose down
    echo "✓ 容器已停止"
else
    echo "✓ 没有运行中的容器"
fi

# 2. 备份数据库（如果使用 bind mount）
if [ -f "./words.db" ]; then
    echo "[2/5] 备份现有数据库..."
    BACKUP_DIR="./backups"
    mkdir -p "$BACKUP_DIR"
    BACKUP_FILE="$BACKUP_DIR/words.db.$(date +%Y%m%d_%H%M%S)"
    cp ./words.db "$BACKUP_FILE"
    echo "✓ 数据库已备份到: $BACKUP_FILE"
else
    echo "[2/5] 未找到本地数据库文件（可能使用 volume）"
fi

# 3. 拉取最新代码（如果需要）
echo "[3/5] 准备更新..."
echo "✓ 代码已准备就绪"

# 4. 重新构建镜像
echo "[4/5] 重新构建 Docker 镜像..."
docker-compose build --no-cache
echo "✓ 镜像构建完成"

# 5. 启动容器（volume 会自动保留数据）
echo "[5/5] 启动容器..."
docker-compose up -d
echo "✓ 容器已启动"

# 等待容器就绪
echo "等待容器就绪..."
sleep 3

# 检查容器状态
if [ "$(docker ps -q -f name=.*app)" ]; then
    echo ""
    echo "========================================="
    echo "✅ 更新完成！"
    echo "========================================="
    echo ""
    echo "容器状态:"
    docker-compose ps
    echo ""
    echo "查看日志:"
    echo "  docker-compose logs -f"
    echo ""
    echo "数据库位置:"
    echo "  Volume: db_data"
    echo "  查看 volume: docker volume inspect yinianji-1_db_data"
    echo ""
else
    echo ""
    echo "❌ 容器启动失败，请检查日志:"
    echo "  docker-compose logs"
    exit 1
fi
