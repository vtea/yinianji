# 本地运行和测试指南

## 本地运行项目

### 1. 安装依赖

```bash
npm install
```

### 2. 构建 Tailwind CSS

```bash
# 生产构建（压缩）
npm run build-css

# 或者开发模式（监听文件变化，自动重新构建）
npm run dev-css
```

### 3. 启动服务器

```bash
npm start
```

或者：

```bash
node server.js
```

### 4. 访问应用

打开浏览器访问：`http://localhost:3000`

## 开发工作流

### 方式 1：两个终端窗口

**终端 1 - CSS 开发模式（监听变化）：**
```bash
npm run dev-css
```

**终端 2 - 启动服务器：**
```bash
npm start
```

这样当你修改 `public/styles.css` 或 HTML 文件中的 Tailwind 类时，CSS 会自动重新构建。

### 方式 2：单终端（手动构建）

```bash
# 1. 构建 CSS
npm run build-css

# 2. 启动服务器
npm start
```

每次修改样式后，需要重新运行 `npm run build-css`。

## Docker 运行

### Docker 构建和运行

Dockerfile 已经配置为自动执行 CSS 构建步骤：

```bash
# 构建镜像（会自动执行 npm install 和 npm run build-css）
docker-compose build

# 启动容器
docker-compose up

# 或者后台运行
docker-compose up -d
```

### Docker 构建流程

Dockerfile 会按以下顺序执行：

1. ✅ 安装所有依赖（包括 devDependencies）
2. ✅ 复制项目文件
3. ✅ **自动执行 `npm run build-css`** 构建 Tailwind CSS
4. ✅ 启动服务器

所以使用 Docker 时，**不需要手动构建 CSS**，构建过程会自动完成。

### 查看日志

```bash
# 查看容器日志
docker-compose logs -f

# 查看特定服务日志
docker-compose logs -f app
```

### 停止容器

```bash
docker-compose down
```

## 常见问题

### 1. CSS 样式没有生效？

- 确保 `public/output.css` 文件存在
- 检查浏览器控制台是否有 404 错误
- 清除浏览器缓存（Ctrl+Shift+R 或 Cmd+Shift+R）

### 2. 修改样式后没有变化？

- 如果使用 `dev-css`，确保它正在运行
- 如果使用 `build-css`，需要重新运行命令
- 检查 `public/output.css` 的修改时间

### 3. Docker 构建失败？

- 检查网络连接（需要下载 npm 包）
- 确保 Dockerfile 中的 Node 版本正确
- 查看构建日志：`docker-compose build --no-cache`

## 文件说明

- `public/styles.css` - Tailwind CSS 源文件（输入）
- `public/output.css` - 编译后的 CSS 文件（输出，已添加到 .gitignore）
- `tailwind.config.js` - Tailwind 配置
- `postcss.config.js` - PostCSS 配置

## 快速测试

```bash
# 一键测试流程
npm install && npm run build-css && npm start
```
