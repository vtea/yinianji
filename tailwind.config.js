/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './public/**/*.html',
  ],
  theme: {
    extend: {
      screens: {
        // 横竖屏方向查询
        'landscape': {'raw': '(orientation: landscape)'},
        'portrait': {'raw': '(orientation: portrait)'},
      },
      colors: {
        // 保留项目原有颜色
        'primary': '#58cc02',
        'primary-hover': '#46a302',
        'secondary': '#1cb0f6',
        'accent': '#ffc800',
      },
    },
  },
  plugins: [],
}
