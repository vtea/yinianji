const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");
const https = require("https");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { default: pinyin } = require("pinyin");

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


// 让服务器可以访问 public 文件夹
app.use(express.static(path.join(__dirname, "public")));

// 创建 / 连接数据库
const dbPath = process.env.DB_PATH || "words.db";
const db = new sqlite3.Database(dbPath);

// 启用外键约束
db.run("PRAGMA foreign_keys = ON");

const SECRET_FILE = path.join(__dirname, ".ai_key_secret");
function loadOrCreateSecret() {
  if (process.env.AI_KEY_SECRET) return process.env.AI_KEY_SECRET;
  try {
    if (fs.existsSync(SECRET_FILE)) {
      return fs.readFileSync(SECRET_FILE, "utf8").trim();
    }
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    return generated;
  } catch (e) {
    return "";
  }
}

const API_KEY_SECRET = loadOrCreateSecret();
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || "10", 10);

function isBcryptHash(value) {
  return typeof value === "string" && value.startsWith("$2");
}

function encryptApiKey(plain) {
  if (!API_KEY_SECRET) {
    throw new Error("缺少 AI_KEY_SECRET 环境变量");
  }
  const key = crypto.createHash("sha256").update(API_KEY_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64")
  ].join(".");
}

function decryptApiKey(payload) {
  if (!API_KEY_SECRET) {
    throw new Error("缺少 AI_KEY_SECRET 环境变量");
  }
  if (!payload) return "";
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) return "";
  const key = crypto.createHash("sha256").update(API_KEY_SECRET).digest();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

// 初始化数据库表
function initDatabase() {
  db.serialize(() => {
    // 创建 users 表
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) console.error("创建 users 表失败：", err);
      else console.log("✓ users 表已创建");
    });

    // 为 users 表添加 api_key_enc 字段
    db.all("PRAGMA table_info(users)", (err, columns) => {
      if (err) return;
      const hasApiKeyEnc = columns && columns.some(col => col.name === "api_key_enc");
      if (!hasApiKeyEnc) {
        db.run("ALTER TABLE users ADD COLUMN api_key_enc TEXT", (err2) => {
          if (err2) console.error("迁移 users 表失败：", err2);
          else console.log("✓ users 表已添加 api_key_enc 列");
        });
      }
    });

    // 创建 words 表
    db.run(`
      CREATE TABLE IF NOT EXISTS words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        hanzi TEXT NOT NULL,
        pinyin TEXT,
        speak_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, hanzi)
      )
    `, (err) => {
      if (err) console.error("创建 words 表失败：", err);
      else console.log("✓ words 表已创建");
    });

    // 检查并迁移旧数据
    db.all("PRAGMA table_info(words)", (err, columns) => {
      if (err) return;
      
      const hasUserIdColumn = columns && columns.some(col => col.name === "user_id");
      
      if (columns && columns.length > 0 && !hasUserIdColumn) {
        console.log("检测到旧表结构，清空重建...");
        db.run("DROP TABLE IF EXISTS words", (err) => {
          if (err) console.error("删除旧表失败：", err);
          else {
            db.run(`
              CREATE TABLE words (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                hanzi TEXT NOT NULL,
                pinyin TEXT,
                speak_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(user_id, hanzi)
              )
            `, (err) => {
              if (err) console.error("重建 words 表失败：", err);
              else console.log("✓ words 表已重建");
            });
          }
        });
      }
    });

    // 创建 pinyin_learn 表（声母韵母学习记录）
    db.run(`
      CREATE TABLE IF NOT EXISTS pinyin_learn (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        pinyin TEXT NOT NULL,
        type TEXT DEFAULT 'initial',
        learn_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_learned_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, pinyin, type)
      )
    `, (err) => {
      if (err) console.error("创建 pinyin_learn 表失败：", err);
      else console.log("✓ pinyin_learn 表已创建");
    });

    // 创建 english_learn 表（英语学习记录）
    db.run(`
      CREATE TABLE IF NOT EXISTS english_learn (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        word TEXT NOT NULL,
        level TEXT DEFAULT 'beginner',
        learn_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_learned_at DATETIME,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, word, level)
      )
    `, (err) => {
      if (err) console.error("创建 english_learn 表失败：", err);
      else console.log("✓ english_learn 表已创建");
    });

    // 创建 english_new_words 表（英语单词本）
    db.run(`
      CREATE TABLE IF NOT EXISTS english_new_words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        word TEXT NOT NULL,
        phonetic TEXT,
        chinese TEXT,
        play_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, word)
      )
    `, (err) => {
      if (err) console.error("创建 english_new_words 表失败：", err);
      else console.log("✓ english_new_words 表已创建");
    });

    // 创建 deleted_words 表（生字删除记录）
    db.run(`
      CREATE TABLE IF NOT EXISTS deleted_words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        hanzi TEXT NOT NULL,
        pinyin TEXT,
        speak_count INTEGER DEFAULT 0,
        added_at DATETIME,
        deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_mastered INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, hanzi)
      )
    `, (err) => {
      if (err) console.error("创建 deleted_words 表失败：", err);
      else console.log("✓ deleted_words 表已创建");
    });

    // 为 deleted_words 表添加 is_mastered 字段（如果不存在）
    db.all("PRAGMA table_info(deleted_words)", (err, columns) => {
      if (err) return;
      const hasIsMastered = columns && columns.some(col => col.name === "is_mastered");
      if (columns && columns.length > 0 && !hasIsMastered) {
        db.run("ALTER TABLE deleted_words ADD COLUMN is_mastered INTEGER DEFAULT 0", (err) => {
          if (err) console.error("迁移 deleted_words 表失败：", err);
          else console.log("✓ deleted_words 表已添加 is_mastered 列");
        });
      }
    });

    // 创建 deleted_english_words 表（英语单词删除记录）
    db.run(`
      CREATE TABLE IF NOT EXISTS deleted_english_words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        word TEXT NOT NULL,
        phonetic TEXT,
        chinese TEXT,
        play_count INTEGER DEFAULT 0,
        added_at DATETIME,
        deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, word)
      )
    `, (err) => {
      if (err) console.error("创建 deleted_english_words 表失败：", err);
      else console.log("✓ deleted_english_words 表已创建");
    });

    // 创建 ai_chat_history 表
    db.run(`
      CREATE TABLE IF NOT EXISTS ai_chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        image_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, (err) => {
      if (err) console.error("创建 ai_chat_history 表失败：", err);
      else console.log("✓ ai_chat_history 表已创建");
    });

    // ==================== 游戏化系统表 ====================

    // 创建 user_game_stats 表（用户游戏统计数据）
    db.run(`
      CREATE TABLE IF NOT EXISTS user_game_stats (
        user_id INTEGER PRIMARY KEY,
        total_exp INTEGER DEFAULT 0,
        current_level INTEGER DEFAULT 1,
        total_stars INTEGER DEFAULT 0,
        consecutive_days INTEGER DEFAULT 0,
        last_learn_date DATE,
        total_words_learned INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, (err) => {
      if (err) console.error("创建 user_game_stats 表失败：", err);
      else console.log("✓ user_game_stats 表已创建");
    });

    // 创建 user_achievements 表（用户成就记录）
    db.run(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        achievement_id TEXT NOT NULL,
        achieved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, achievement_id)
      )
    `, (err) => {
      if (err) console.error("创建 user_achievements 表失败：", err);
      else console.log("✓ user_achievements 表已创建");
    });

    // 创建 word_mastery 表（生字掌握程度）
    db.run(`
      CREATE TABLE IF NOT EXISTS word_mastery (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        word_id INTEGER NOT NULL,
        mastery_level INTEGER DEFAULT 0,
        last_practiced_at DATETIME,
        correct_count INTEGER DEFAULT 0,
        wrong_count INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE,
        UNIQUE(user_id, word_id)
      )
    `, (err) => {
      if (err) console.error("创建 word_mastery 表失败：", err);
      else console.log("✓ word_mastery 表已创建");
    });

    // 创建 game_sessions 表（游戏会话记录）
    db.run(`
      CREATE TABLE IF NOT EXISTS game_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        game_type TEXT NOT NULL,
        score INTEGER DEFAULT 0,
        exp_earned INTEGER DEFAULT 0,
        played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, (err) => {
      if (err) console.error("创建 game_sessions 表失败：", err);
      else console.log("✓ game_sessions 表已创建");
    });

    // 为 words 表添加掌握度相关字段（如果不存在）
    db.all("PRAGMA table_info(words)", (err, columns) => {
      if (err) return;
      const hasMasteryLevel = columns && columns.some(col => col.name === "mastery_level");
      if (columns && columns.length > 0 && !hasMasteryLevel) {
        db.run("ALTER TABLE words ADD COLUMN mastery_level INTEGER DEFAULT 0", (err) => {
          if (err) console.error("迁移 words 表失败：", err);
          else console.log("✓ words 表已添加 mastery_level 列");
        });
      }
      const hasLastPracticed = columns && columns.some(col => col.name === "last_practiced_at");
      if (columns && columns.length > 0 && !hasLastPracticed) {
        db.run("ALTER TABLE words ADD COLUMN last_practiced_at DATETIME", (err) => {
          if (err) console.error("迁移 words 表失败：", err);
          else console.log("✓ words 表已添加 last_practiced_at 列");
        });
      }
      const hasIsMastered = columns && columns.some(col => col.name === "is_mastered");
      if (columns && columns.length > 0 && !hasIsMastered) {
        db.run("ALTER TABLE words ADD COLUMN is_mastered INTEGER DEFAULT 0", (err) => {
          if (err) console.error("迁移 words 表失败：", err);
          else console.log("✓ words 表已添加 is_mastered 列");
        });
      }
      const hasMasteredAt = columns && columns.some(col => col.name === "mastered_at");
      if (columns && columns.length > 0 && !hasMasteredAt) {
        db.run("ALTER TABLE words ADD COLUMN mastered_at DATETIME", (err) => {
          if (err) console.error("迁移 words 表失败：", err);
          else console.log("✓ words 表已添加 mastered_at 列");
        });
      }
    });

    // 为 word_mastery 表添加连续正确次数和掌握时间字段
    db.all("PRAGMA table_info(word_mastery)", (err, columns) => {
      if (err) return;
      const hasConsecutiveCorrect = columns && columns.some(col => col.name === "consecutive_correct");
      if (columns && columns.length > 0 && !hasConsecutiveCorrect) {
        db.run("ALTER TABLE word_mastery ADD COLUMN consecutive_correct INTEGER DEFAULT 0", (err) => {
          if (err) console.error("迁移 word_mastery 表失败：", err);
          else console.log("✓ word_mastery 表已添加 consecutive_correct 列");
        });
      }
      const hasMasteredAt = columns && columns.some(col => col.name === "mastered_at");
      if (columns && columns.length > 0 && !hasMasteredAt) {
        db.run("ALTER TABLE word_mastery ADD COLUMN mastered_at DATETIME", (err) => {
          if (err) console.error("迁移 word_mastery 表失败：", err);
          else console.log("✓ word_mastery 表已添加 mastered_at 列");
        });
      }
    });

    // 检查并迁移 english_new_words 表（添加 play_count）
    db.all("PRAGMA table_info(english_new_words)", (err, columns) => {
      if (err) return;
      const hasPlayCount = columns && columns.some(col => col.name === "play_count");
      if (columns && columns.length > 0 && !hasPlayCount) {
        db.run("ALTER TABLE english_new_words ADD COLUMN play_count INTEGER DEFAULT 0", (err) => {
          if (err) console.error("迁移 english_new_words 表失败：", err);
          else console.log("✓ english_new_words 表已添加 play_count 列");
        });
      }
    });
  });
}

initDatabase();

// 注册接口
app.post("/api/register", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "用户名和密码不能为空" });
  }

  if (username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: "用户名至少 3 个字符，密码至少 6 个字符" });
  }

  bcrypt.hash(password, BCRYPT_ROUNDS, (hashErr, hashedPassword) => {
    if (hashErr) {
      console.error("密码加密失败：", hashErr);
      return res.sendStatus(500);
    }
    db.run(
      "INSERT INTO users (username, password) VALUES (?, ?)",
      [username, hashedPassword],
      (err) => {
        if (err) {
          if (err.message.includes("UNIQUE constraint failed")) {
            return res.status(409).json({ error: "用户名已存在" });
          }
          console.error("注册失败：", err);
          return res.sendStatus(500);
        }
        res.status(200).json({ success: true, message: "注册成功" });
      }
    );
  });
});

// 登录接口
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "用户名和密码不能为空" });
  }

  db.get(
    "SELECT id, username, password FROM users WHERE username = ?",
    [username],
    (err, row) => {
      if (err) {
        console.error("登录查询失败：", err);
        return res.status(500).json({ error: "查询失败" });
      }

      if (!row) {
        return res.status(401).json({ error: "用户名或密码错误" });
      }

      const stored = row.password || "";
      if (isBcryptHash(stored)) {
        bcrypt.compare(password, stored, (cmpErr, match) => {
          if (cmpErr) {
            console.error("密码校验失败：", cmpErr);
            return res.status(500).json({ error: "查询失败" });
          }
          if (!match) {
            return res.status(401).json({ error: "用户名或密码错误" });
          }
          res.json({ success: true, user_id: row.id, username: row.username });
        });
      } else {
        if (stored !== password) {
          return res.status(401).json({ error: "用户名或密码错误" });
        }
        // 旧明文密码，登录后迁移为加密存储
        bcrypt.hash(password, BCRYPT_ROUNDS, (hashErr, hashedPassword) => {
          if (!hashErr) {
            db.run(
              "UPDATE users SET password = ? WHERE id = ?",
              [hashedPassword, row.id]
            );
          }
          res.json({ success: true, user_id: row.id, username: row.username });
        });
      }
    }
  );
});

// 读取用户的所有生字
app.get("/api/words/:user_id", (req, res) => {
  const { user_id } = req.params;

  if (!user_id || user_id === "undefined") {
    return res.status(400).json({ error: "用户未登录" });
  }

  db.all(
    `SELECT w.id, w.hanzi, w.pinyin, COALESCE(w.speak_count, 0) as speak_count, w.created_at,
            COALESCE(w.mastery_level, 0) as mastery_level, w.last_practiced_at,
            COALESCE(w.is_mastered, 0) as is_mastered, w.mastered_at
     FROM words w
     WHERE w.user_id = ?
     ORDER BY w.id DESC`,
    [user_id],
    (err, rows) => {
      if (err) {
        console.error("查询失败：", err);
        // 如果是列不存在的错误，使用 0 作为默认值
        if (err.message.includes("no such column")) {
          db.all(
            `SELECT id, hanzi, pinyin, COALESCE(speak_count, 0) as speak_count, created_at,
                    0 as mastery_level, NULL as last_practiced_at,
                    0 as is_mastered, NULL as mastered_at
             FROM words WHERE user_id = ? ORDER BY id DESC`,
            [user_id],
            (err2, rows2) => {
              if (err2) {
                console.error("备用查询失败：", err2);
                return res.sendStatus(500);
              }
              res.json(rows2 || []);
            }
          );
        } else {
          return res.sendStatus(500);
        }
      } else {
        res.json(rows || []);
      }
    }
  );
});

// 生字统计
app.get("/api/word-stats/chinese/:user_id", (req, res) => {
  const { user_id } = req.params;
  if (!user_id || user_id === "undefined") {
    return res.status(400).json({ error: "用户未登录" });
  }

  db.get("SELECT COUNT(*) as count FROM words WHERE user_id = ?", [user_id], (err, row) => {
    if (err) return res.sendStatus(500);
    const unknownCount = row ? row.count : 0;
    db.get("SELECT COUNT(*) as count FROM deleted_words WHERE user_id = ?", [user_id], (err2, row2) => {
      if (err2) return res.sendStatus(500);
      const knownCount = row2 ? row2.count : 0;
      res.json({ unknownCount, knownCount });
    });
  });
});

// 英语单词本统计
app.get("/api/word-stats/english/:user_id", (req, res) => {
  const { user_id } = req.params;
  if (!user_id || user_id === "undefined") {
    return res.status(400).json({ error: "用户未登录" });
  }

  db.get("SELECT COUNT(*) as count FROM english_new_words WHERE user_id = ?", [user_id], (err, row) => {
    if (err) return res.sendStatus(500);
    const unknownCount = row ? row.count : 0;
    db.get("SELECT COUNT(*) as count FROM deleted_english_words WHERE user_id = ?", [user_id], (err2, row2) => {
      if (err2) return res.sendStatus(500);
      const knownCount = row2 ? row2.count : 0;
      res.json({ unknownCount, knownCount });
    });
  });
});

// 添加生字
app.post("/api/words", (req, res) => {
  const { user_id, hanzi } = req.body;

  if (!user_id || !hanzi) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  // 检查生字是否已存在
  db.get(
    "SELECT id FROM words WHERE user_id = ? AND hanzi = ?",
    [user_id, hanzi],
    (err, row) => {
      if (err) {
        console.error("查询失败：", err);
        return res.status(500).json({ error: "查询失败" });
      }

      if (row) {
        console.log("生字已存在：", hanzi);
        return res.status(409).json({ error: "生字已存在" });
      }

      db.get(
        "SELECT hanzi, speak_count, added_at FROM deleted_words WHERE user_id = ? AND hanzi = ?",
        [user_id, hanzi],
        (err2, deletedRow) => {
          if (err2) {
            console.error("查询删除记录失败：", err2);
          }

          // 自动生成拼音
          const py = pinyin(hanzi, {
            style: pinyin.STYLE_TONE
          })
            .flat()
            .join(" ");

          db.run(
            "INSERT INTO words (user_id, hanzi, pinyin, speak_count, created_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)",
            [user_id, hanzi, py],
            (err3) => {
              if (err3) {
                console.error("保存失败：", err3);
                return res.sendStatus(500);
              }

              if (deletedRow) {
                db.run(
                  "DELETE FROM deleted_words WHERE user_id = ? AND hanzi = ?",
                  [user_id, hanzi]
                );
              }

              // 获得经验值（添加生字 +10 EXP）
              initUserGameStats(user_id).then(() => {
                db.get("SELECT total_exp, current_level FROM user_game_stats WHERE user_id = ?", [user_id], (err4, expRow) => {
                  if (!err4 && expRow) {
                    const oldExp = expRow.total_exp || 0;
                    const oldLevel = expRow.current_level || 1;
                    const newExp = oldExp + 10;
                    
                    let newLevel = oldLevel;
                    while (newExp >= getExpForLevel(newLevel + 1)) {
                      newLevel++;
                    }
                    
                    db.run(
                      "UPDATE user_game_stats SET total_exp = ?, current_level = ?, total_words_learned = total_words_learned + 1 WHERE user_id = ?",
                      [newExp, newLevel, user_id],
                      () => {
                        // 检查成就
                        db.get("SELECT COUNT(*) as count FROM words WHERE user_id = ?", [user_id], (err5, wordRow) => {
                          if (!err5 && wordRow) {
                            const count = wordRow.count || 0;
                            if (count === 1) checkAchievement(user_id, "first_word", () => {});
                            if (count === 50) checkAchievement(user_id, "master_50_words", () => {});
                          }
                        });
                        updateConsecutiveDays(user_id).catch(() => {});
                      }
                    );
                  }
                });
              }).catch(() => {});

              console.log("保存成功：", hanzi, py);
              res.status(200).json({
                success: true,
                prevDeleted: deletedRow
                  ? { added_at: deletedRow.added_at, speak_count: deletedRow.speak_count }
                  : null
              });
            }
          );
        }
      );
    }
  );
});

// 增加朗读次数
app.post("/api/speak", (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: "缺少 id 参数" });
  }

  // 先获取用户ID
  db.get("SELECT user_id, speak_count FROM words WHERE id = ?", [id], (err, wordRow) => {
    if (err || !wordRow) {
      console.error("查询生字失败：", err);
      return res.sendStatus(500);
    }

    const user_id = wordRow.user_id;
    const oldSpeakCount = wordRow.speak_count || 0;

    db.run(
      "UPDATE words SET speak_count = speak_count + 1 WHERE id = ?",
      [id],
      (err2) => {
        if (err2) {
          console.error("更新失败：", err2);
          return res.sendStatus(500);
        }

        // 获得经验值（朗读 +5 EXP）
        initUserGameStats(user_id).then(() => {
          db.get("SELECT total_exp, current_level FROM user_game_stats WHERE user_id = ?", [user_id], (err3, expRow) => {
            if (!err3 && expRow) {
              const oldExp = expRow.total_exp || 0;
              const oldLevel = expRow.current_level || 1;
              const newExp = oldExp + 5;
              
              let newLevel = oldLevel;
              while (newExp >= getExpForLevel(newLevel + 1)) {
                newLevel++;
              }
              
              db.run(
                "UPDATE user_game_stats SET total_exp = ?, current_level = ? WHERE user_id = ?",
                [newExp, newLevel, user_id],
                () => {
                  // 检查朗读成就（累计10次）
                  db.get("SELECT SUM(speak_count) as total FROM words WHERE user_id = ?", [user_id], (err4, speakRow) => {
                    if (!err4 && speakRow) {
                      const totalSpeaks = speakRow.total || 0;
                      if (totalSpeaks >= 10) {
                        checkAchievement(user_id, "read_10", () => {});
                      }
                    }
                  });
                  updateConsecutiveDays(user_id).catch(() => {});
                }
              );
            }
          });
        }).catch(() => {});

        res.json({ success: true });
      }
    );
  });
});

// ==================== 声母韵母学习 API ====================

// 获取用户的声母韵母学习记录
app.get("/api/pinyin/:user_id", (req, res) => {
  const { user_id } = req.params;

  db.all(
    "SELECT * FROM pinyin_learn WHERE user_id = ? ORDER BY type, pinyin",
    [user_id],
    (err, rows) => {
      if (err) {
        console.error("查询失败：", err);
        return res.sendStatus(500);
      }
      res.json(rows || []);
    }
  );
});

// 获取所有声母韵母（用于首次初始化）
app.get("/api/pinyin-list", (req, res) => {
  const initials = [
    "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h",
    "j", "q", "x", "zh", "ch", "sh", "r", "z", "c", "s", "y", "w"
  ];

  const finals = [
    "a", "o", "e", "i", "u", "ü", "er",
    "ai", "ei", "ao", "ou", "an", "en", "ang", "eng", "ong",
    "ia", "ie", "iao", "iu", "ian", "in", "iang", "ing", "iong",
    "ua", "uo", "uai", "ui", "uan", "un", "uang", "ueng",
    "üe", "üan", "ün"
  ];

  res.json({
    initials,
    finals
  });
});

// 初始化声母韵母学习记录
app.post("/api/pinyin-init", (req, res) => {
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: "缺少 user_id 参数" });
  }

  const initials = [
    "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h",
    "j", "q", "x", "zh", "ch", "sh", "r", "z", "c", "s", "y", "w"
  ];

  const finals = [
    "a", "o", "e", "i", "u", "ü", "er",
    "ai", "ei", "ao", "ou", "an", "en", "ang", "eng", "ong",
    "ia", "ie", "iao", "iu", "ian", "in", "iang", "ing", "iong",
    "ua", "uo", "uai", "ui", "uan", "un", "uang", "ueng",
    "üe", "üan", "ün"
  ];

  let completed = 0;
  const total = initials.length + finals.length;

  const insertPinyin = (pinyinList, type) => {
    pinyinList.forEach((py) => {
      db.run(
        `INSERT OR IGNORE INTO pinyin_learn (user_id, pinyin, type, learn_count, created_at)
         VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)`,
        [user_id, py, type],
        (err) => {
          if (err) console.error(`插入 ${type} "${py}" 失败：`, err);
          completed++;
          if (completed === total) {
            res.json({ success: true });
          }
        }
      );
    });
  };

  insertPinyin(initials, "initial");
  insertPinyin(finals, "final");
});

// 更新声母韵母学习次数
app.post("/api/pinyin-learn", (req, res) => {
  const { user_id, pinyin, type } = req.body;

  if (!user_id || !pinyin || !type) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  db.run(
    `UPDATE pinyin_learn 
     SET learn_count = learn_count + 1, last_learned_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND pinyin = ? AND type = ?`,
    [user_id, pinyin, type],
    (err) => {
      if (err) {
        console.error("更新失败：", err);
        return res.sendStatus(500);
      }
      res.json({ success: true });
    }
  );
});

// ==================== 英语学习 API ====================

// 更新英语学习记录
app.post("/api/english-learn", (req, res) => {
  const { user_id, word, level } = req.body;

  if (!user_id || !word || !level) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  db.run(
    `INSERT INTO english_learn (user_id, word, level, learn_count, created_at, last_learned_at)
     VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, word, level) DO UPDATE SET 
       learn_count = learn_count + 1,
       last_learned_at = CURRENT_TIMESTAMP`,
    [user_id, word, level],
    (err) => {
      if (err) {
        console.error("记录英语学习失败：", err);
        return res.sendStatus(500);
      }
      res.json({ success: true });
    }
  );
});

// 获取用户的英语学习记录
app.get("/api/english/:user_id", (req, res) => {
  const { user_id } = req.params;

  db.all(
    "SELECT * FROM english_learn WHERE user_id = ? ORDER BY level, word",
    [user_id],
    (err, rows) => {
      if (err) {
        console.error("查询失败：", err);
        return res.sendStatus(500);
      }
      res.json(rows || []);
    }
  );
});

// ==================== 英语单词本 API ====================

// 获取用户的单词本
app.get("/api/english-new-words/:user_id", (req, res) => {
  const { user_id } = req.params;

  db.all(
    "SELECT * FROM english_new_words WHERE user_id = ? ORDER BY created_at DESC",
    [user_id],
    (err, rows) => {
      if (err) {
        console.error("查询单词本失败：", err);
        return res.sendStatus(500);
      }
      res.json(rows || []);
    }
  );
});

// 添加单词到单词本
app.post("/api/english-new-words", (req, res) => {
  const { user_id, word, phonetic, chinese } = req.body;

  if (!user_id || !word) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  db.get("SELECT id FROM english_new_words WHERE user_id = ? AND word = ?", [user_id, word], (err, existing) => {
    if (err) {
      console.error("查询失败：", err);
      return res.sendStatus(500);
    }

    db.get(
      "SELECT word, play_count, added_at FROM deleted_english_words WHERE user_id = ? AND word = ?",
      [user_id, word],
      (err2, deletedRow) => {
        if (err2) {
          console.error("查询删除记录失败：", err2);
        }

        db.run(
          `INSERT INTO english_new_words (user_id, word, phonetic, chinese)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, word) DO UPDATE SET 
             phonetic = excluded.phonetic,
             chinese = excluded.chinese`,
          [user_id, word, phonetic, chinese],
          (err3) => {
            if (err3) {
              console.error("添加单词到单词本失败：", err3);
              return res.sendStatus(500);
            }

            if (deletedRow) {
              db.run(
                "DELETE FROM deleted_english_words WHERE user_id = ? AND word = ?",
                [user_id, word]
              );
            }

            res.json({
              success: true,
              prevDeleted: !existing && deletedRow
                ? { added_at: deletedRow.added_at, play_count: deletedRow.play_count }
                : null
            });
          }
        );
      }
    );
  });
});

// 从单词本中删除单词
app.delete("/api/english-new-words", (req, res) => {
  const { user_id, word } = req.body;

  if (!user_id || !word) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  db.get(
    "SELECT user_id, word, phonetic, chinese, play_count, created_at FROM english_new_words WHERE user_id = ? AND word = ?",
    [user_id, word],
    (err, row) => {
      if (err) {
        console.error("查询单词本单词失败：", err);
        return res.sendStatus(500);
      }

      if (row) {
        db.run(
          `INSERT OR REPLACE INTO deleted_english_words (user_id, word, phonetic, chinese, play_count, added_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [row.user_id, row.word, row.phonetic, row.chinese, row.play_count || 0, row.created_at],
          (err2) => {
            if (err2) console.error("记录删除历史失败：", err2);
            db.run(
              "DELETE FROM english_new_words WHERE user_id = ? AND word = ?",
              [user_id, word],
              (err3) => {
                if (err3) {
                  console.error("删除单词本单词失败：", err3);
                  return res.sendStatus(500);
                }
                res.json({ success: true });
              }
            );
          }
        );
      } else {
        res.json({ success: true });
      }
    }
  );
});

// 增加单词本播放次数
app.post("/api/english-new-words/speak", (req, res) => {
  const { user_id, word } = req.body;

  if (!user_id || !word) {
    return res.status(400).json({ error: "缺少参数" });
  }

  db.run(
    "UPDATE english_new_words SET play_count = play_count + 1 WHERE user_id = ? AND word = ?",
    [user_id, word],
    (err) => {
      if (err) {
        console.error("更新播放次数失败：", err);
        return res.sendStatus(500);
      }
      res.json({ success: true });
    }
  );
});

// 英语单词查询代理（解决 CORS 问题）
app.get("/api/proxy/english/:word", (req, res) => {
  const { word } = req.params;
  
  // 同时请求有道建议和 Dictionary API
  const results = { chinese: "", phonetic: "" };
  let completed = 0;

  const checkDone = () => {
    completed++;
    if (completed === 2) {
      res.json(results);
    }
  };

  // 获取翻译
  https.get(`https://dict.youdao.com/suggest?q=${word}&num=1&doctype=json`, (resp) => {
    let data = '';
    resp.on('data', (chunk) => data += chunk);
    resp.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.data && json.data.entries && json.data.entries.length > 0) {
          results.chinese = json.data.entries[0].explain;
        }
      } catch (e) {}
      checkDone();
    });
  }).on("error", checkDone);

  // 获取音标
  https.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`, (resp) => {
    let data = '';
    resp.on('data', (chunk) => data += chunk);
    resp.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (Array.isArray(json) && json.length > 0) {
          results.phonetic = json[0].phonetic || (json[0].phonetics && json[0].phonetics.find(p => p.text)?.text) || "";
        }
      } catch (e) {}
      checkDone();
    });
  }).on("error", checkDone);
});

// 检查熟练掌握的生字
app.get("/api/check-mastered/:user_id", (req, res) => {
  const { user_id } = req.params;
  if (!user_id || user_id === "undefined") {
    return res.status(400).json({ error: "用户未登录" });
  }

  db.all(
    `SELECT w.id as word_id, w.hanzi, w.pinyin, w.mastery_level, w.mastered_at,
            wm.consecutive_correct
     FROM words w
     LEFT JOIN word_mastery wm ON w.id = wm.word_id AND wm.user_id = w.user_id
     WHERE w.user_id = ? AND w.is_mastered = 1
     ORDER BY w.mastered_at DESC`,
    [user_id],
    (err, rows) => {
      if (err) {
        console.error("查询已掌握生字失败：", err);
        return res.sendStatus(500);
      }
      res.json(rows || []);
    }
  );
});

// 删除生字（增强版：支持奖励）
app.post("/api/delete", (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: "缺少 id 参数" });
  }

  db.get("SELECT user_id, hanzi, pinyin, speak_count, created_at, is_mastered FROM words WHERE id = ?", [id], (err, row) => {
    if (err || !row) {
      if (err) console.error("查询失败：", err);
      return res.sendStatus(500);
    }

    const isMastered = row.is_mastered || 0;
    let expReward = 0;
    let starsReward = 0;

    // 如果删除的是已熟练掌握的生字，给予奖励
    if (isMastered) {
      expReward = 50;
      starsReward = 2;
    }

    db.run(
      `INSERT OR REPLACE INTO deleted_words (user_id, hanzi, pinyin, speak_count, added_at, deleted_at, is_mastered)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
      [row.user_id, row.hanzi, row.pinyin, row.speak_count || 0, row.created_at, isMastered],
      (err2) => {
        if (err2) console.error("记录删除历史失败：", err2);
        db.run("DELETE FROM words WHERE id = ?", [id], (err3) => {
          if (err3) {
            console.error("删除失败：", err3);
            return res.sendStatus(500);
          }

          // 如果删除的是已掌握的生字，给予奖励
          if (isMastered) {
            initUserGameStats(row.user_id).then(() => {
              // 更新经验值
              db.get("SELECT total_exp, current_level FROM user_game_stats WHERE user_id = ?", [row.user_id], (err4, expRow) => {
                if (!err4 && expRow) {
                  const oldExp = expRow.total_exp || 0;
                  const oldLevel = expRow.current_level || 1;
                  const newExp = oldExp + expReward;
                  
                  let newLevel = oldLevel;
                  while (newExp >= getExpForLevel(newLevel + 1)) {
                    newLevel++;
                  }
                  
                  db.run(
                    "UPDATE user_game_stats SET total_exp = ?, current_level = ?, total_stars = total_stars + ? WHERE user_id = ?",
                    [newExp, newLevel, starsReward, row.user_id],
                    () => {
                      // 检查累计熟练掌握成就（优化：合并查询）
                      db.get(
                        `SELECT 
                          (SELECT COUNT(*) FROM words WHERE user_id = ? AND is_mastered = 1) as current_mastered,
                          (SELECT COUNT(*) FROM deleted_words WHERE user_id = ? AND is_mastered = 1) as deleted_mastered`,
                        [row.user_id, row.user_id],
                        (err5, countRow) => {
                          if (!err5 && countRow) {
                            const totalMastered = (countRow.current_mastered || 0) + (countRow.deleted_mastered || 0);
                            if (totalMastered >= 10) checkAchievement(row.user_id, "master_10_words", () => {});
                            if (totalMastered >= 50) checkAchievement(row.user_id, "master_50_mastered", () => {});
                          }
                        }
                      );
                    }
                  );
                }
              });
            }).catch(() => {});
          }

          console.log("删除成功：", id);
          res.json({
            success: true,
            is_mastered: isMastered === 1,
            exp_reward: expReward,
            stars_reward: starsReward
          });
        });
      }
    );
  });
});



// 修改密码接口
app.post("/api/change-password", (req, res) => {
  const { user_id, oldPassword, newPassword } = req.body;

  if (!user_id || !oldPassword || !newPassword) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  db.get(
    "SELECT password FROM users WHERE id = ?",
    [user_id],
    (err, row) => {
      if (err || !row) return res.status(500).json({ error: "用户不存在" });
      const stored = row.password || "";
      const verify = (ok) => {
        if (!ok) return res.status(401).json({ error: "旧密码错误" });
        bcrypt.hash(newPassword, BCRYPT_ROUNDS, (hashErr, hashedPassword) => {
          if (hashErr) return res.status(500).json({ error: "更新失败" });
          db.run(
            "UPDATE users SET password = ? WHERE id = ?",
            [hashedPassword, user_id],
            (err2) => {
              if (err2) return res.status(500).json({ error: "更新失败" });
              res.json({ success: true });
            }
          );
        });
      };

      if (isBcryptHash(stored)) {
        bcrypt.compare(oldPassword, stored, (cmpErr, match) => {
          if (cmpErr) return res.status(500).json({ error: "更新失败" });
          verify(match);
        });
      } else {
        verify(stored === oldPassword);
      }
    }
  );
});

// 获取 AI Key 是否配置
app.get("/api/ai-key-status/:user_id", (req, res) => {
  const { user_id } = req.params;
  if (!user_id || user_id === "undefined") {
    return res.status(400).json({ error: "用户未登录" });
  }
  db.get("SELECT api_key_enc FROM users WHERE id = ?", [user_id], (err, row) => {
    if (err) {
      console.error("查询 API Key 失败：", err);
      return res.sendStatus(500);
    }
    res.json({ configured: !!(row && row.api_key_enc) });
  });
});

// 保存 AI Key（加密）
app.post("/api/ai-key", (req, res) => {
  const { user_id, apiKey } = req.body;
  if (!user_id || !apiKey) {
    return res.status(400).json({ error: "缺少必要参数" });
  }
  let encrypted;
  try {
    encrypted = encryptApiKey(apiKey);
  } catch (e) {
    console.error("API Key 加密失败：", e);
    return res.status(500).json({ error: e.message || "加密失败" });
  }
  db.run(
    "UPDATE users SET api_key_enc = ? WHERE id = ?",
    [encrypted, user_id],
    (err) => {
      if (err) {
        console.error("保存 API Key 失败：", err);
        return res.sendStatus(500);
      }
      res.json({ success: true });
    }
  );
});

// AI 辅导代理接口
app.post("/api/ai-tutor", async (req, res) => {
  const { user_id, model, prompt, image } = req.body;
  if (!user_id) {
    return res.status(400).json({ error: "缺少用户信息" });
  }
  let API_KEY = "";
  try {
    API_KEY = await new Promise((resolve, reject) => {
      db.get("SELECT api_key_enc FROM users WHERE id = ?", [user_id], (err, row) => {
        if (err) return reject(err);
        resolve(row && row.api_key_enc ? decryptApiKey(row.api_key_enc) : "");
      });
    });
  } catch (e) {
    console.error("读取 API Key 失败：", e);
    return res.status(500).json({ error: "读取 API Key 失败" });
  }
  const API_URL = "https://api.aass.cc/v1/chat/completions";

  try {
    if (!API_KEY) {
      return res.status(400).json({ error: "缺少 API Key，请在账户中配置" });
    }
    // 保存用户消息
    if (user_id) {
      db.run("INSERT INTO ai_chat_history (user_id, role, content, image_data) VALUES (?, ?, ?, ?)", [user_id, 'user', prompt || '', image || null]);
    }

    const messages = [
      {
        role: "system",
        content: "你是一位耐心的一年级辅导老师。你的任务是帮助小朋友理解问题，而不是直接给出答案。请使用亲切、简单、富有鼓励性的语言。重要规则：1. 禁止使用 ###, ---, > 等复杂的 Markdown 符号。2. 使用简单的空格和换行来分段。3. 重点词汇可以用少量的加粗，但不要大面积使用。4. 保持回答简洁，每次只专注于解释一个知识点，不要一次给太多信息。5. 回复中不要包含任何代码块或编程相关的特殊字符。"
      }
    ];

    const userContent = [];
    if (prompt) userContent.push({ type: "text", text: prompt });
    if (image) {
      const base64Data = image.split(",")[1] || image;
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${base64Data}` }
      });
    }

    messages.push({ role: "user", content: userContent });

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.7
      })
    });

    const data = await response.json();
    if (data.error) {
      const msg = data.error.message || "API Error";
      throw new Error(msg);
    }
    
    const reply = data.choices[0].message.content;

    // 保存 AI 回复
    if (user_id) {
      db.run("INSERT INTO ai_chat_history (user_id, role, content) VALUES (?, ?, ?)", [user_id, 'ai', reply]);
    }

    res.json({ reply });
  } catch (error) {
    const message = error && error.message ? error.message : "AI 老师暂时不在位，请检查网络或配置";
    console.error("AI Proxy Error:", error);
    res.status(500).json({ error: message });
  }
});

// 获取 AI 对话历史
app.get("/api/ai-chat-history/:user_id", (req, res) => {
  const { user_id } = req.params;
  db.all("SELECT * FROM ai_chat_history WHERE user_id = ? ORDER BY created_at ASC", [user_id], (err, rows) => {
    if (err) return res.status(500).json({ error: "查询失败" });
    res.json(rows || []);
  });
});

// 删除 AI 对话记录
app.delete("/api/ai-chat-history/:user_id", (req, res) => {
  const { user_id } = req.params;
  const { id } = req.body;
  
  if (id) {
    db.run("DELETE FROM ai_chat_history WHERE user_id = ? AND id = ?", [user_id, id], (err) => {
      if (err) return res.status(500).json({ error: "删除失败" });
      res.json({ success: true });
    });
  } else {
    db.run("DELETE FROM ai_chat_history WHERE user_id = ?", [user_id], (err) => {
      if (err) return res.status(500).json({ error: "清空失败" });
      res.json({ success: true });
    });
  }
});

// ==================== 游戏化系统 API ====================

// 计算等级所需经验值
function getExpForLevel(level) {
  return level * 100 + (level - 1) * 50;
}

// 初始化用户游戏数据
function initUserGameStats(user_id) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR IGNORE INTO user_game_stats 
       (user_id, total_exp, current_level, total_stars, consecutive_days, total_words_learned)
       VALUES (?, 0, 1, 0, 0, 0)`,
      [user_id],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// 检查并更新连续学习天数
function updateConsecutiveDays(user_id) {
  return new Promise((resolve, reject) => {
    db.get("SELECT last_learn_date, consecutive_days FROM user_game_stats WHERE user_id = ?", [user_id], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(0);
      
      const today = new Date().toISOString().split('T')[0];
      const lastDate = row.last_learn_date ? new Date(row.last_learn_date).toISOString().split('T')[0] : null;
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      
      let newConsecutiveDays = row.consecutive_days || 0;
      
      if (lastDate === today) {
        // 今天已经学习过，不更新连续天数，但更新日期（防止重复计算）
        resolve(newConsecutiveDays);
        return;
      } else if (lastDate === yesterdayStr) {
        // 昨天学习过，连续天数+1
        newConsecutiveDays = (row.consecutive_days || 0) + 1;
      } else if (lastDate && lastDate < yesterdayStr) {
        // 中断了，重置为1
        newConsecutiveDays = 1;
      } else {
        // 第一次学习或lastDate为null
        newConsecutiveDays = 1;
      }
      
      db.run(
        "UPDATE user_game_stats SET consecutive_days = ?, last_learn_date = ? WHERE user_id = ?",
        [newConsecutiveDays, today, user_id],
        (err2) => {
          if (err2) reject(err2);
          else resolve(newConsecutiveDays);
        }
      );
    });
  });
}

// 获取用户游戏数据
app.get("/api/game-stats/:user_id", (req, res) => {
  const { user_id } = req.params;
  if (!user_id || user_id === "undefined") {
    return res.status(400).json({ error: "用户未登录" });
  }

  initUserGameStats(user_id).then(() => {
    db.get("SELECT * FROM user_game_stats WHERE user_id = ?", [user_id], (err, stats) => {
      if (err) {
        console.error("查询游戏数据失败：", err);
        return res.sendStatus(500);
      }
      
      if (!stats) {
        return res.json({
          total_exp: 0,
          current_level: 1,
          total_stars: 0,
          consecutive_days: 0,
          total_words_learned: 0,
          exp_to_next_level: getExpForLevel(2) - 0,
          current_level_exp: 0
        });
      }
      
      const currentLevel = stats.current_level || 1;
      const currentLevelExp = stats.total_exp || 0;
      const expForCurrentLevel = getExpForLevel(currentLevel);
      const expForNextLevel = getExpForLevel(currentLevel + 1);
      const expToNextLevel = expForNextLevel - currentLevelExp;
      const currentLevelProgress = currentLevelExp - expForCurrentLevel;
      
      res.json({
        total_exp: stats.total_exp || 0,
        current_level: currentLevel,
        total_stars: stats.total_stars || 0,
        consecutive_days: stats.consecutive_days || 0,
        total_words_learned: stats.total_words_learned || 0,
        exp_to_next_level: expToNextLevel,
        current_level_exp: currentLevelProgress,
        exp_for_current_level: expForCurrentLevel,
        exp_for_next_level: expForNextLevel
      });
    });
  }).catch(err => {
    console.error("初始化游戏数据失败：", err);
    res.sendStatus(500);
  });
});

// 获得经验值
app.post("/api/game-earn-exp", (req, res) => {
  const { user_id, exp, source } = req.body;
  
  if (!user_id || !exp || exp <= 0) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  initUserGameStats(user_id).then(() => {
    db.get("SELECT total_exp, current_level FROM user_game_stats WHERE user_id = ?", [user_id], (err, row) => {
      if (err) {
        console.error("查询失败：", err);
        return res.sendStatus(500);
      }
      
      const oldLevel = row ? (row.current_level || 1) : 1;
      const oldExp = row ? (row.total_exp || 0) : 0;
      const newExp = oldExp + exp;
      
      // 计算新等级
      let newLevel = oldLevel;
      let levelUp = false;
      while (newExp >= getExpForLevel(newLevel + 1)) {
        newLevel++;
        levelUp = true;
      }
      
      // 更新经验值和等级
      db.run(
        "UPDATE user_game_stats SET total_exp = ?, current_level = ? WHERE user_id = ?",
        [newExp, newLevel, user_id],
        (err2) => {
          if (err2) {
            console.error("更新经验值失败：", err2);
            return res.sendStatus(500);
          }
          
          // 如果升级了，检查成就
          if (levelUp) {
            checkAchievement(user_id, `level_${newLevel}`, () => {});
          }
          
          // 根据来源检查其他成就
          if (source === "add_word") {
            db.get("SELECT COUNT(*) as count FROM words WHERE user_id = ?", [user_id], (err3, wordRow) => {
              if (!err3 && wordRow) {
                const count = wordRow.count || 0;
                if (count === 1) checkAchievement(user_id, "first_word", () => {});
                if (count === 50) checkAchievement(user_id, "master_50_words", () => {});
              }
            });
          }
          
          // 更新连续学习天数
          updateConsecutiveDays(user_id).then(days => {
            if (days === 7) {
              checkAchievement(user_id, "consecutive_7_days", () => {});
            }
          }).catch(() => {});
          
          res.json({
            success: true,
            new_exp: newExp,
            new_level: newLevel,
            level_up: levelUp,
            exp_earned: exp
          });
        }
      );
    });
  }).catch(err => {
    console.error("初始化游戏数据失败：", err);
    res.sendStatus(500);
  });
});

// 更新生字掌握度（统一函数，避免重复代码）
function updateWordMastery(user_id, word_id, isCorrect) {
  return new Promise((resolve) => {
    // 先查询word_mastery和words表获取当前状态
    db.get(
      `SELECT wm.correct_count, wm.wrong_count, wm.consecutive_correct, COALESCE(w.is_mastered, 0) as is_mastered
       FROM word_mastery wm
       LEFT JOIN words w ON w.id = wm.word_id AND w.user_id = wm.user_id
       WHERE wm.user_id = ? AND wm.word_id = ?`,
      [user_id, word_id],
      (err, row) => {
        // 如果word_mastery中没有记录，从words表查询is_mastered
        if (err || !row) {
          db.get(
            "SELECT is_mastered FROM words WHERE id = ? AND user_id = ?",
            [word_id, user_id],
            (err2, wordRow) => {
              if (err2) {
                console.error("查询掌握度失败：", err2);
                return resolve({ mastery_level: 0, consecutive_correct: 0, is_mastered: 0, newly_mastered: false });
              }
              
              // 如果没有记录，使用默认值
              let correctCount = 0;
              let wrongCount = 0;
              let consecutiveCorrect = 0;
              const wasMastered = wordRow ? (wordRow.is_mastered || 0) : 0;
              
              // 继续处理
              updateMasteryData(user_id, word_id, isCorrect, correctCount, wrongCount, consecutiveCorrect, wasMastered, resolve);
            }
          );
          return;
        }
        
        let correctCount = row ? (row.correct_count || 0) : 0;
        let wrongCount = row ? (row.wrong_count || 0) : 0;
        let consecutiveCorrect = row ? (row.consecutive_correct || 0) : 0;
        const wasMastered = row ? (row.is_mastered || 0) : 0;
        
        updateMasteryData(user_id, word_id, isCorrect, correctCount, wrongCount, consecutiveCorrect, wasMastered, resolve);
      }
    );
  });
}

// 处理掌握度更新的核心逻辑
function updateMasteryData(user_id, word_id, isCorrect, correctCount, wrongCount, consecutiveCorrect, wasMastered, resolve) {
  // 更新连续正确次数
  if (isCorrect) {
    correctCount++;
    consecutiveCorrect++;
  } else {
    wrongCount++;
    consecutiveCorrect = 0; // 错误时重置连续正确次数
  }
  
  // 重新计算掌握等级
  const total = correctCount + wrongCount;
  let masteryLevel = 0;
  if (total > 0) {
    const accuracy = correctCount / total;
    if (total >= 20 && accuracy >= 0.95) {
      masteryLevel = 5;
    } else if (total >= 11 && accuracy >= 0.85) {
      masteryLevel = 4;
    } else if (total >= 6 && accuracy >= 0.70) {
      masteryLevel = 3;
    } else if (total >= 3 && accuracy >= 0.50) {
      masteryLevel = 2;
    } else if (total >= 1) {
      masteryLevel = 1;
    }
  }
  
  // 检查是否达到熟练掌握标准（5级 + 连续正确10次）
  let isMastered = wasMastered; // 保持已掌握状态
  let masteredAt = null;
  if (masteryLevel === 5 && consecutiveCorrect >= 10 && !wasMastered) {
    isMastered = 1;
    masteredAt = new Date().toISOString();
  }
  
  db.run(
    `INSERT INTO word_mastery (user_id, word_id, mastery_level, last_practiced_at, correct_count, wrong_count, consecutive_correct, mastered_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)
     ON CONFLICT(user_id, word_id) DO UPDATE SET
       mastery_level = excluded.mastery_level,
       correct_count = excluded.correct_count,
       wrong_count = excluded.wrong_count,
       consecutive_correct = excluded.consecutive_correct,
       last_practiced_at = excluded.last_practiced_at,
       mastered_at = COALESCE(excluded.mastered_at, mastered_at)`,
    [user_id, word_id, masteryLevel, correctCount, wrongCount, consecutiveCorrect, masteredAt],
    () => {
      // 同步更新 words 表
      db.run(
        "UPDATE words SET mastery_level = ?, last_practiced_at = CURRENT_TIMESTAMP, is_mastered = ?, mastered_at = COALESCE(?, mastered_at) WHERE id = ?",
        [masteryLevel, isMastered, masteredAt, word_id],
        () => {
          // 检查完美掌握成就
          if (masteryLevel === 5) {
            checkAchievement(user_id, "perfect_mastery", () => {});
          }
          resolve({ 
            mastery_level: masteryLevel, 
            consecutive_correct: consecutiveCorrect,
            is_mastered: isMastered,
            newly_mastered: isMastered && !wasMastered
          });
        }
      );
    }
  );
}

// 检查并解锁成就
function checkAchievement(user_id, achievement_id, callback) {
  db.get(
    "SELECT id FROM user_achievements WHERE user_id = ? AND achievement_id = ?",
    [user_id, achievement_id],
    (err, row) => {
      if (err || row) {
        return callback(false); // 已存在或出错
      }
      
      // 解锁成就
      db.run(
        "INSERT INTO user_achievements (user_id, achievement_id) VALUES (?, ?)",
        [user_id, achievement_id],
        (err2) => {
          if (err2) {
            console.error("解锁成就失败：", err2);
            return callback(false);
          }
          
          // 奖励星星
          db.run(
            "UPDATE user_game_stats SET total_stars = total_stars + 1 WHERE user_id = ?",
            [user_id],
            () => {}
          );
          
          callback(true);
        }
      );
    }
  );
}

// 获取成就列表
app.get("/api/achievements/:user_id", (req, res) => {
  const { user_id } = req.params;
  if (!user_id || user_id === "undefined") {
    return res.status(400).json({ error: "用户未登录" });
  }

  const allAchievements = [
    { id: "first_word", name: "初出茅庐", desc: "添加第一个生字", icon: "🌱" },
    { id: "read_10", name: "小试牛刀", desc: "累计朗读10次", icon: "📖" },
    { id: "level_5", name: "渐入佳境", desc: "达到等级5", icon: "⭐" },
    { id: "master_50_words", name: "熟能生巧", desc: "掌握50个生字", icon: "🎯" },
    { id: "consecutive_7_days", name: "持之以恒", desc: "连续学习7天", icon: "🔥" },
    { id: "perfect_mastery", name: "完美主义", desc: "单个生字掌握度达到5级", icon: "💎" },
    { id: "master_10_words", name: "小有成就", desc: "熟练掌握10个生字", icon: "🏆" },
    { id: "master_50_mastered", name: "学有所成", desc: "熟练掌握50个生字", icon: "👑" },
    { id: "game_100", name: "游戏达人", desc: "完成100局游戏", icon: "🎮" },
    { id: "speed_star", name: "速度之星", desc: "挑战模式30秒内答对10题", icon: "⚡" }
  ];

  db.all("SELECT achievement_id FROM user_achievements WHERE user_id = ?", [user_id], (err, unlocked) => {
    if (err) {
      console.error("查询成就失败：", err);
      return res.sendStatus(500);
    }
    
    const unlockedIds = new Set(unlocked.map(a => a.achievement_id));
    const achievements = allAchievements.map(a => ({
      ...a,
      unlocked: unlockedIds.has(a.id)
    }));
    
    res.json(achievements);
  });
});

// 检查新成就（用于实时检查）
app.get("/api/check-achievements/:user_id", (req, res) => {
  const { user_id } = req.params;
  if (!user_id || user_id === "undefined") {
    return res.status(400).json({ error: "用户未登录" });
  }

  // 优化：合并查询以减少数据库访问次数
  Promise.all([
    // 合并查询：生字数量和朗读次数
    new Promise((resolve) => {
      db.get(
        `SELECT COUNT(*) as word_count, COALESCE(SUM(speak_count), 0) as speak_total 
         FROM words WHERE user_id = ?`,
        [user_id],
        (err, row) => {
          if (!err && row) {
            const wordCount = row.word_count || 0;
            const speakTotal = row.speak_total || 0;
            if (wordCount >= 1) checkAchievement(user_id, "first_word", () => {});
            if (wordCount >= 50) checkAchievement(user_id, "master_50_words", () => {});
            if (speakTotal >= 10) checkAchievement(user_id, "read_10", () => {});
          }
          resolve();
        }
      );
    }),
    // 合并查询：游戏统计（等级、连续天数）
    new Promise((resolve) => {
      db.get(
        `SELECT current_level, consecutive_days 
         FROM user_game_stats WHERE user_id = ?`,
        [user_id],
        (err, row) => {
          if (!err && row) {
            const level = row.current_level || 1;
            const days = row.consecutive_days || 0;
            if (level >= 5) checkAchievement(user_id, "level_5", () => {});
            if (days >= 7) checkAchievement(user_id, "consecutive_7_days", () => {});
          }
          resolve();
        }
      );
    }),
    // 检查完美掌握
    new Promise((resolve) => {
      db.get(
        "SELECT COUNT(*) as count FROM word_mastery WHERE user_id = ? AND mastery_level = 5",
        [user_id],
        (err, row) => {
          if (!err && row) {
            const count = row.count || 0;
            if (count >= 1) checkAchievement(user_id, "perfect_mastery", () => {});
          }
          resolve();
        }
      );
    }),
    // 检查游戏次数
    new Promise((resolve) => {
      db.get(
        "SELECT COUNT(*) as count FROM game_sessions WHERE user_id = ?",
        [user_id],
        (err, row) => {
          if (!err && row) {
            const count = row.count || 0;
            if (count >= 100) checkAchievement(user_id, "game_100", () => {});
          }
          resolve();
        }
      );
    })
  ]).then(() => {
    // 返回最新的成就列表
    db.all("SELECT achievement_id FROM user_achievements WHERE user_id = ?", [user_id], (err, unlocked) => {
      if (err) {
        console.error("查询成就列表失败：", err);
        return res.sendStatus(500);
      }
      res.json({ unlocked: unlocked.map(a => a.achievement_id) });
    });
  }).catch(err => {
    console.error("检查成就失败：", err);
    res.sendStatus(500);
  });
});

// 更新生字掌握度（使用统一的updateWordMastery函数）
app.post("/api/word-mastery", (req, res) => {
  const { user_id, word_id, correct } = req.body;
  
  if (!user_id || !word_id || typeof correct !== "boolean") {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  updateWordMastery(user_id, word_id, correct)
    .then(result => {
      res.json({
        success: true,
        mastery_level: result.mastery_level,
        consecutive_correct: result.consecutive_correct,
        is_mastered: result.is_mastered,
        newly_mastered: result.newly_mastered
      });
    })
    .catch(err => {
      console.error("更新掌握度失败：", err);
      res.status(500).json({ error: "更新掌握度失败" });
    });
});

// 获取游戏用生字列表
app.get("/api/words-for-game/:user_id", (req, res) => {
  const { user_id } = req.params;
  const { filter } = req.query; // "all", "new", "review", "mastered"

  if (!user_id || user_id === "undefined") {
    return res.status(400).json({ error: "用户未登录" });
  }

  let query = `
    SELECT w.*, COALESCE(wm.mastery_level, 0) as mastery_level
    FROM words w
    LEFT JOIN word_mastery wm ON w.id = wm.word_id AND wm.user_id = ?
    WHERE w.user_id = ?
  `;

  const params = [user_id, user_id];

  if (filter === "new") {
    query += " AND COALESCE(wm.mastery_level, 0) = 0";
  } else if (filter === "review") {
    query += " AND COALESCE(wm.mastery_level, 0) BETWEEN 1 AND 3";
  } else if (filter === "mastered") {
    query += " AND COALESCE(wm.mastery_level, 0) >= 4";
  }

  query += " ORDER BY RANDOM() LIMIT 20";

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error("查询生字失败：", err);
      return res.sendStatus(500);
    }
    res.json(rows || []);
  });
});

// 保存游戏会话
app.post("/api/game-session", (req, res) => {
  const { user_id, game_type, score, exp_earned } = req.body;

  if (!user_id || !game_type) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  db.run(
    "INSERT INTO game_sessions (user_id, game_type, score, exp_earned) VALUES (?, ?, ?, ?)",
    [user_id, game_type, score || 0, exp_earned || 0],
    (err) => {
      if (err) {
        console.error("保存游戏会话失败：", err);
        return res.sendStatus(500);
      }

      // 检查游戏成就
      db.get(
        "SELECT COUNT(*) as count FROM game_sessions WHERE user_id = ?",
        [user_id],
        (err2, row) => {
          if (!err2 && row && row.count >= 100) {
            checkAchievement(user_id, "game_100", () => {});
          }
        }
      );

      res.json({ success: true });
    }
  );
});

// ==================== 游戏模式 API ====================

// 配对游戏 - 生成题目
app.post("/api/game-match", (req, res) => {
  const { user_id, count } = req.body;
  const questionCount = count || 10;

  if (!user_id || user_id === "undefined") {
    return res.status(400).json({ error: "用户未登录" });
  }

  // 获取生字列表
  db.all(
    `SELECT w.id, w.hanzi, w.pinyin
     FROM words w
     WHERE w.user_id = ?
     ORDER BY RANDOM()
     LIMIT ?`,
    [user_id, questionCount],
    (err, words) => {
      if (err) {
        console.error("查询生字失败：", err);
        return res.sendStatus(500);
      }

      if (words.length === 0) {
        return res.status(400).json({ error: "请先添加一些生字" });
      }

      // 生成配对题目
      const questions = words.map(word => ({
        word_id: word.id,
        hanzi: word.hanzi,
        correct_pinyin: word.pinyin,
        options: []
      }));

      // 为每个题目生成干扰选项
      questions.forEach((q, idx) => {
        // 获取所有不同的拼音（排除正确答案）
        const allPinyins = words
          .map(w => w.pinyin)
          .filter((py, i) => i !== idx && py && py !== q.correct_pinyin);
        
        // 去重并随机选择3个
        const uniquePinyins = [...new Set(allPinyins)];
        const shuffled = uniquePinyins.sort(() => Math.random() - 0.5);
        const otherPinyins = shuffled.slice(0, 3);
        
        // 如果干扰选项不足3个，用常见拼音补充
        const commonPinyins = ["mā", "bà", "nǐ", "wǒ", "tā", "hǎo", "shì", "de"];
        while (otherPinyins.length < 3) {
          const randomPinyin = commonPinyins[Math.floor(Math.random() * commonPinyins.length)];
          if (!otherPinyins.includes(randomPinyin) && randomPinyin !== q.correct_pinyin) {
            otherPinyins.push(randomPinyin);
          }
        }
        
        // 打乱选项顺序
        const allOptions = [q.correct_pinyin, ...otherPinyins].sort(() => Math.random() - 0.5);
        q.options = allOptions;
      });

      res.json({ questions });
    }
  );
});

// 配对游戏 - 提交答案
app.post("/api/game-match/submit", (req, res) => {
  const { user_id, answers } = req.body; // answers: [{ word_id, selected_pinyin }]

  if (!user_id || !answers || !Array.isArray(answers)) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  // 验证答案
  const wordIds = answers.map(a => a.word_id);
  db.all(
    "SELECT id, hanzi, pinyin FROM words WHERE id IN (" + wordIds.map(() => "?").join(",") + ")",
    wordIds,
    (err, words) => {
      if (err) {
        console.error("查询生字失败：", err);
        return res.sendStatus(500);
      }

      const wordMap = {};
      words.forEach(w => { wordMap[w.id] = w; });

      let correctCount = 0;
      const results = answers.map(answer => {
        const word = wordMap[answer.word_id];
        const isCorrect = word && word.pinyin === answer.selected_pinyin;
        if (isCorrect) correctCount++;
        return {
          word_id: answer.word_id,
          hanzi: word ? word.hanzi : "",
          correct: isCorrect,
          correct_pinyin: word ? word.pinyin : ""
        };
      });

      // 计算得分和经验值
      const score = correctCount * 10;
      const expEarned = correctCount * 3 + (correctCount === answers.length ? 10 : 0); // 每对+3，全对额外+10

      // 保存游戏会话
      db.run(
        "INSERT INTO game_sessions (user_id, game_type, score, exp_earned) VALUES (?, ?, ?, ?)",
        [user_id, "match", score, expEarned],
        () => {}
      );

      // 更新经验值
      initUserGameStats(user_id).then(() => {
        db.get("SELECT total_exp, current_level FROM user_game_stats WHERE user_id = ?", [user_id], (err2, expRow) => {
          if (!err2 && expRow) {
            const oldExp = expRow.total_exp || 0;
            const oldLevel = expRow.current_level || 1;
            const newExp = oldExp + expEarned;
            
            let newLevel = oldLevel;
            while (newExp >= getExpForLevel(newLevel + 1)) {
              newLevel++;
            }
            
            db.run(
              "UPDATE user_game_stats SET total_exp = ?, current_level = ? WHERE user_id = ?",
              [newExp, newLevel, user_id],
              () => {}
            );
          }
        });
      }).catch(() => {});

      // 更新生字掌握度（使用统一函数）
      Promise.all(results.map(result => 
        updateWordMastery(user_id, result.word_id, result.correct)
      )).then(() => {
        res.json({
          success: true,
          score,
          correct_count: correctCount,
          total_count: answers.length,
          exp_earned: expEarned,
          results
        });
      });
    }
  );
});

// 听音选字游戏 - 生成题目
app.post("/api/game-listen", (req, res) => {
  const { user_id, count } = req.body;
  const questionCount = count || 10;

  if (!user_id || user_id === "undefined") {
    return res.status(400).json({ error: "用户未登录" });
  }

  // 获取生字列表
  db.all(
    `SELECT w.id, w.hanzi, w.pinyin
     FROM words w
     WHERE w.user_id = ?
     ORDER BY RANDOM()
     LIMIT ?`,
    [user_id, questionCount],
    (err, words) => {
      if (err) {
        console.error("查询生字失败：", err);
        return res.sendStatus(500);
      }

      if (words.length === 0) {
        return res.status(400).json({ error: "请先添加一些生字" });
      }

      // 生成题目
      const questions = words.map((word, idx) => {
        // 生成干扰选项（其他生字）
        const otherWords = words
          .filter((w, i) => i !== idx)
          .map(w => ({ id: w.id, hanzi: w.hanzi }))
          .slice(0, 3);
        
        // 确保有4个选项
        while (otherWords.length < 3) {
          otherWords.push({ id: -1, hanzi: "?" });
        }
        
        // 打乱选项顺序
        const allOptions = [
          { id: word.id, hanzi: word.hanzi, is_correct: true },
          ...otherWords.map(w => ({ ...w, is_correct: false }))
        ].sort(() => Math.random() - 0.5);

        return {
          word_id: word.id,
          pinyin: word.pinyin,
          hanzi: word.hanzi,
          options: allOptions
        };
      });

      res.json({ questions });
    }
  );
});

// 听音选字游戏 - 提交答案
app.post("/api/game-listen/submit", (req, res) => {
  const { user_id, answers } = req.body; // answers: [{ word_id, selected_hanzi_id }]

  if (!user_id || !answers || !Array.isArray(answers)) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  // 验证答案
  const wordIds = answers.map(a => a.word_id);
  db.all(
    "SELECT id, hanzi, pinyin FROM words WHERE id IN (" + wordIds.map(() => "?").join(",") + ")",
    wordIds,
    (err, words) => {
      if (err) {
        console.error("查询生字失败：", err);
        return res.sendStatus(500);
      }

      const wordMap = {};
      words.forEach(w => { wordMap[w.id] = w; });

      let correctCount = 0;
      let consecutiveCorrect = 0;
      let maxConsecutive = 0;

      const results = answers.map(answer => {
        const word = wordMap[answer.word_id];
        const isCorrect = word && word.id === answer.selected_hanzi_id;
        if (isCorrect) {
          correctCount++;
          consecutiveCorrect++;
          maxConsecutive = Math.max(maxConsecutive, consecutiveCorrect);
        } else {
          consecutiveCorrect = 0;
        }
        return {
          word_id: answer.word_id,
          pinyin: word ? word.pinyin : "",
          correct: isCorrect,
          correct_hanzi: word ? word.hanzi : ""
        };
      });

      // 计算得分和经验值（答对+5，连续答对额外奖励）
      const score = correctCount * 10;
      const baseExp = correctCount * 5;
      const bonusExp = maxConsecutive >= 3 ? Math.floor(maxConsecutive / 3) * 5 : 0;
      const expEarned = baseExp + bonusExp;

      // 保存游戏会话
      db.run(
        "INSERT INTO game_sessions (user_id, game_type, score, exp_earned) VALUES (?, ?, ?, ?)",
        [user_id, "listen", score, expEarned],
        () => {}
      );

      // 更新经验值
      initUserGameStats(user_id).then(() => {
        db.get("SELECT total_exp, current_level FROM user_game_stats WHERE user_id = ?", [user_id], (err2, expRow) => {
          if (!err2 && expRow) {
            const oldExp = expRow.total_exp || 0;
            const oldLevel = expRow.current_level || 1;
            const newExp = oldExp + expEarned;
            
            let newLevel = oldLevel;
            while (newExp >= getExpForLevel(newLevel + 1)) {
              newLevel++;
            }
            
            db.run(
              "UPDATE user_game_stats SET total_exp = ?, current_level = ? WHERE user_id = ?",
              [newExp, newLevel, user_id],
              () => {}
            );
          }
        });
      }).catch(() => {});

      // 更新生字掌握度（使用统一函数）
      Promise.all(results.map(result => 
        updateWordMastery(user_id, result.word_id, result.correct)
      )).then(() => {
        res.json({
          success: true,
          score,
          correct_count: correctCount,
          total_count: answers.length,
          max_consecutive: maxConsecutive,
          exp_earned: expEarned,
          results
        });
      });
    }
  );
});

// 拼写游戏 - 生成题目
app.post("/api/game-spell", (req, res) => {
  const { user_id, count } = req.body;
  const questionCount = count || 10;

  if (!user_id || user_id === "undefined") {
    return res.status(400).json({ error: "用户未登录" });
  }

  // 获取生字列表
  db.all(
    `SELECT w.id, w.hanzi, w.pinyin
     FROM words w
     WHERE w.user_id = ?
     ORDER BY RANDOM()
     LIMIT ?`,
    [user_id, questionCount],
    (err, words) => {
      if (err) {
        console.error("查询生字失败：", err);
        return res.sendStatus(500);
      }

      if (words.length === 0) {
        return res.status(400).json({ error: "请先添加一些生字" });
      }

      // 生成题目
      const questions = words.map(word => ({
        word_id: word.id,
        pinyin: word.pinyin,
        correct_hanzi: word.hanzi
      }));

      res.json({ questions });
    }
  );
});

// 拼写游戏 - 提交答案
app.post("/api/game-spell/submit", (req, res) => {
  const { user_id, answers } = req.body; // answers: [{ word_id, input_hanzi }]

  if (!user_id || !answers || !Array.isArray(answers)) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  // 验证答案
  const wordIds = answers.map(a => a.word_id);
  db.all(
    "SELECT id, hanzi, pinyin FROM words WHERE id IN (" + wordIds.map(() => "?").join(",") + ")",
    wordIds,
    (err, words) => {
      if (err) {
        console.error("查询生字失败：", err);
        return res.sendStatus(500);
      }

      const wordMap = {};
      words.forEach(w => { wordMap[w.id] = w; });

      let correctCount = 0;
      const results = answers.map(answer => {
        const word = wordMap[answer.word_id];
        const isCorrect = word && word.hanzi === answer.input_hanzi.trim();
        if (isCorrect) correctCount++;
        return {
          word_id: answer.word_id,
          pinyin: word ? word.pinyin : "",
          correct: isCorrect,
          correct_hanzi: word ? word.hanzi : "",
          input_hanzi: answer.input_hanzi
        };
      });

      // 计算得分和经验值（答对+8）
      const score = correctCount * 10;
      const expEarned = correctCount * 8;

      // 保存游戏会话
      db.run(
        "INSERT INTO game_sessions (user_id, game_type, score, exp_earned) VALUES (?, ?, ?, ?)",
        [user_id, "spell", score, expEarned],
        () => {}
      );

      // 更新经验值
      initUserGameStats(user_id).then(() => {
        db.get("SELECT total_exp, current_level FROM user_game_stats WHERE user_id = ?", [user_id], (err2, expRow) => {
          if (!err2 && expRow) {
            const oldExp = expRow.total_exp || 0;
            const oldLevel = expRow.current_level || 1;
            const newExp = oldExp + expEarned;
            
            let newLevel = oldLevel;
            while (newExp >= getExpForLevel(newLevel + 1)) {
              newLevel++;
            }
            
            db.run(
              "UPDATE user_game_stats SET total_exp = ?, current_level = ? WHERE user_id = ?",
              [newExp, newLevel, user_id],
              () => {}
            );
          }
        });
      }).catch(() => {});

      // 更新生字掌握度（使用统一函数）
      Promise.all(results.map(result => 
        updateWordMastery(user_id, result.word_id, result.correct)
      )).then(() => {
        res.json({
          success: true,
          score,
          correct_count: correctCount,
          total_count: answers.length,
          exp_earned: expEarned,
          results
        });
      });
    }
  );
});

const PORT = process.env.PORT || 3000;



app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
