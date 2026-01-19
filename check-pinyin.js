/**
 * 拼音质量检查工具
 * 用途：检查数据库中所有生字的拼音准确性
 * 
 * 使用方法：
 * node check-pinyin.js [--fix]
 * 
 * --fix: 自动修复不准确的拼音（慎用）
 */

const sqlite3 = require("sqlite3").verbose();
const { default: pinyin } = require("pinyin");
const path = require("path");

// 数据库路径
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "words.db");
const AUTO_FIX = process.argv.includes("--fix");

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("❌ 数据库连接失败：", err);
    process.exit(1);
  }
  console.log("✅ 数据库连接成功：", DB_PATH);
});

console.log("\n🔍 开始检查拼音质量...\n");
if (AUTO_FIX) {
  console.log("⚠️  自动修复模式已启用\n");
}

db.all("SELECT id, hanzi, pinyin, user_id FROM words ORDER BY user_id, hanzi", (err, words) => {
  if (err) {
    console.error("❌ 查询失败：", err);
    db.close();
    process.exit(1);
  }

  if (words.length === 0) {
    console.log("ℹ️  数据库中没有生字");
    db.close();
    return;
  }

  console.log(`📚 共找到 ${words.length} 个生字\n`);

  let issueCount = 0;
  let fixCount = 0;
  const issues = [];

  words.forEach(word => {
    // 生成正确的拼音
    const correctPinyin = pinyin(word.hanzi, {
      style: pinyin.STYLE_TONE
    })
      .flat()
      .join(" ");

    // 检查是否一致
    if (correctPinyin !== word.pinyin && correctPinyin.length > 0) {
      issueCount++;
      const issue = {
        id: word.id,
        user_id: word.user_id,
        hanzi: word.hanzi,
        current: word.pinyin,
        correct: correctPinyin
      };
      issues.push(issue);

      console.log(`⚠️  [用户${word.user_id}] ${word.hanzi}`);
      console.log(`   当前拼音: ${word.pinyin}`);
      console.log(`   建议拼音: ${correctPinyin}\n`);

      // 自动修复
      if (AUTO_FIX) {
        db.run(
          "UPDATE words SET pinyin = ? WHERE id = ?",
          [correctPinyin, word.id],
          (err) => {
            if (err) {
              console.error(`   ❌ 修复失败: ${err.message}`);
            } else {
              fixCount++;
              console.log(`   ✅ 已修复`);
            }
          }
        );
      }
    }
  });

  // 等待所有更新完成
  setTimeout(() => {
    console.log("\n" + "=".repeat(50));
    console.log("📊 检查结果统计");
    console.log("=".repeat(50));
    console.log(`总生字数: ${words.length}`);
    console.log(`发现问题: ${issueCount}`);
    if (AUTO_FIX) {
      console.log(`已修复: ${fixCount}`);
    }
    console.log("=".repeat(50));

    if (issueCount > 0 && !AUTO_FIX) {
      console.log("\n💡 提示：运行 'node check-pinyin.js --fix' 可以自动修复这些问题");
      console.log("⚠️  注意：自动修复可能不适用于多音字，请谨慎使用\n");
    }

    // 生成报告文件
    if (issues.length > 0) {
      const fs = require("fs");
      const report = {
        timestamp: new Date().toISOString(),
        total: words.length,
        issues: issueCount,
        fixed: AUTO_FIX ? fixCount : 0,
        details: issues
      };
      fs.writeFileSync(
        "pinyin-check-report.json",
        JSON.stringify(report, null, 2)
      );
      console.log("📄 详细报告已保存到: pinyin-check-report.json\n");
    }

    db.close();
  }, AUTO_FIX ? 1000 : 0);
});
