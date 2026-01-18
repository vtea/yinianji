# Docker 数据持久化指南

## 问题说明

使用 Docker 更新项目时，如果使用 bind mount (`./words.db:/app/words.db`)，可能会遇到以下问题：

1. **数据丢失风险**：重新构建镜像或更新容器时，如果操作不当可能导致数据丢失
2. **权限问题**：容器内外的文件权限可能不一致
3. **文件不存在问题**：如果宿主机上数据库文件不存在，Docker 会创建目录而不是文件

## 解决方案

我们已经将 `docker-compose.yml` 更新为使用 **Docker 命名 volume**，这样可以：

- ✅ 数据持久化：数据存储在 Docker 管理的 volume 中，不会因为容器更新而丢失
- ✅ 自动管理：Docker 自动处理权限和文件系统
- ✅ 更安全：数据与容器生命周期分离

## 配置说明

### 新的 docker-compose.yml 配置

```yaml
volumes:
  # 使用命名 volume 确保数据持久化
  db_data:/data

volumes:
  # 命名 volume，确保数据在容器更新时不会丢失
  db_data:
    driver: local
```

数据库路径已改为：`/data/words.db`（在 volume 中）

## 迁移现有数据

如果您已经有使用 bind mount 的数据库，请按以下步骤迁移：

### 方法 1：使用迁移脚本（推荐）

```bash
# 运行迁移脚本
./docker-migrate-data.sh
```

脚本会自动：
1. 停止现有容器
2. 创建 Docker volume
3. 将现有数据库复制到 volume
4. 备份原数据库文件
5. 启动新容器

### 方法 2：手动迁移

```bash
# 1. 停止容器
docker-compose down

# 2. 创建 volume
docker volume create yinianji-1_db_data

# 3. 复制数据库到 volume（如果有本地文件）
docker run --rm \
  -v "$(pwd)/words.db:/source/words.db:ro" \
  -v yinianji-1_db_data:/data \
  alpine sh -c "cp /source/words.db /data/words.db && chmod 666 /data/words.db"

# 4. 启动新容器
docker-compose up -d
```

## 更新项目（不会丢失数据）

### 使用更新脚本

```bash
./docker-update.sh
```

### 手动更新

```bash
# 1. 停止容器（volume 数据会保留）
docker-compose down

# 2. 重新构建镜像
docker-compose build

# 3. 启动容器（volume 会自动挂载）
docker-compose up -d
```

## 数据管理

### 查看 volume 信息

```bash
docker volume inspect yinianji-1_db_data
```

### 备份数据库

```bash
# 创建备份目录
mkdir -p ./backups

# 备份 volume 数据
docker run --rm \
  -v yinianji-1_db_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/db-backup-$(date +%Y%m%d).tar.gz -C /data .
```

### 恢复数据库

```bash
# 停止容器
docker-compose down

# 恢复数据
docker run --rm \
  -v yinianji-1_db_data:/data \
  -v $(pwd)/backups:/backup \
  alpine sh -c "cd /data && rm -f words.db && tar xzf /backup/db-backup-YYYYMMDD.tar.gz"

# 启动容器
docker-compose up -d
```

### 删除 volume（⚠️ 危险操作）

```bash
# 停止并删除容器
docker-compose down -v

# ⚠️ 这会删除所有数据！请先备份！
```

## 验证数据持久化

更新后验证数据是否保留：

```bash
# 1. 查看容器日志
docker-compose logs

# 2. 进入容器检查数据库
docker-compose exec app ls -la /data/

# 3. 检查数据库文件
docker-compose exec app sqlite3 /data/words.db "SELECT COUNT(*) FROM words;"
```

## 常见问题

### Q: 更新后数据丢失了？

A: 请检查：
1. 是否使用了新的 `docker-compose.yml` 配置
2. volume 是否存在：`docker volume ls | grep db_data`
3. 查看 volume 内容：`docker run --rm -v yinianji-1_db_data:/data alpine ls -la /data`

### Q: 如何从 volume 导出数据库到本地？

```bash
docker run --rm \
  -v yinianji-1_db_data:/data \
  -v $(pwd):/backup \
  alpine cp /data/words.db /backup/words.db
```

### Q: 可以同时使用 bind mount 和 volume 吗？

不推荐。请选择一种方式：
- **开发环境**：可以使用 bind mount 方便调试
- **生产环境**：推荐使用 volume 更安全可靠

## 最佳实践

1. **定期备份**：设置定时任务自动备份 volume 数据
2. **更新前备份**：每次更新前手动备份一次
3. **测试环境验证**：在测试环境先验证更新流程
4. **监控日志**：更新后检查应用日志确保正常运行

## 备份脚本示例

创建 `backup-db.sh`：

```bash
#!/bin/bash
BACKUP_DIR="./backups"
mkdir -p "$BACKUP_DIR"

docker run --rm \
  -v yinianji-1_db_data:/data \
  -v "$(pwd)/$BACKUP_DIR:/backup" \
  alpine tar czf "/backup/db-backup-$(date +%Y%m%d_%H%M%S).tar.gz" -C /data .

# 保留最近 30 天的备份
find "$BACKUP_DIR" -name "db-backup-*.tar.gz" -mtime +30 -delete

echo "备份完成: $BACKUP_DIR"
```

添加到 crontab（每天凌晨 2 点备份）：

```bash
0 2 * * * /path/to/backup-db.sh
```
