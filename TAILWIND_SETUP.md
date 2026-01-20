# Tailwind CSS 安装和构建指南

## 第一步：安装依赖

由于网络问题，请手动执行：

```bash
cd "/Users/vtea/Library/Mobile Documents/com~apple~CloudDocs/Code/yinianji-1"
npm install -D tailwindcss postcss autoprefixer
```

## 第二步：构建CSS

安装完成后，构建CSS文件：

```bash
# 生产环境（压缩）
npm run build-css

# 开发环境（监听文件变化）
npm run dev-css
```

这会生成 `public/output.css` 文件。

## 第三步：在HTML中引入

在所有HTML文件的 `<head>` 中添加：

```html
<link href="/output.css" rel="stylesheet">
```

## 注意事项

- `output.css` 应该添加到 `.gitignore`（因为它是构建产物）
- 每次修改 `styles.css` 后需要重新构建
- 开发时可以使用 `npm run dev-css` 自动监听变化
