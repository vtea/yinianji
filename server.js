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
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, hanzi)
      )
    `, (err) => {
      if (err) console.error("创建 deleted_words 表失败：", err);
      else console.log("✓ deleted_words 表已创建");
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
    "SELECT id, hanzi, pinyin, COALESCE(speak_count, 0) as speak_count, created_at FROM words WHERE user_id = ? ORDER BY id DESC",
    [user_id],
    (err, rows) => {
      if (err) {
        console.error("查询失败：", err);
        // 如果是列不存在的错误，使用 0 作为默认值
        if (err.message.includes("no such column: speak_count")) {
          db.all(
            "SELECT id, hanzi, pinyin, 0 as speak_count, created_at FROM words WHERE user_id = ? ORDER BY id DESC",
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

  db.run(
    "UPDATE words SET speak_count = speak_count + 1 WHERE id = ?",
    [id],
    (err) => {
      if (err) {
        console.error("更新失败：", err);
        return res.sendStatus(500);
      }
      res.json({ success: true });
    }
  );
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

// 删除生字
app.post("/api/delete", (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: "缺少 id 参数" });
  }

  db.get("SELECT user_id, hanzi, pinyin, speak_count, created_at FROM words WHERE id = ?", [id], (err, row) => {
    if (err || !row) {
      if (err) console.error("查询失败：", err);
      return res.sendStatus(500);
    }

    db.run(
      `INSERT OR REPLACE INTO deleted_words (user_id, hanzi, pinyin, speak_count, added_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [row.user_id, row.hanzi, row.pinyin, row.speak_count || 0, row.created_at],
      (err2) => {
        if (err2) console.error("记录删除历史失败：", err2);
        db.run("DELETE FROM words WHERE id = ?", [id], (err3) => {
          if (err3) {
            console.error("删除失败：", err3);
            return res.sendStatus(500);
          }
          console.log("删除成功：", id);
          res.sendStatus(200);
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


const PORT = process.env.PORT || 3000;



app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
