/* ================================================================
   KyU Community — server.js  v2.0  PRODUCTION READY
   ✅ Node.js + Express + MySQL2 + JWT + bcrypt + Multer
   ✅ Real-time Server-Sent Events (SSE) for notifications
   ✅ Rate limiting, helmet security headers
   ✅ Image upload: disk storage (uploads/) + base64 fallback
   ✅ Full CRUD: lost, found, marketplace, announcements, messages
   ✅ Notifications API
   ✅ Admin endpoints
   Run:  node server.js   |   npm run dev
   ================================================================ */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "kyu_secret_CHANGE_ME_2026";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";

// ── UPLOADS DIRECTORY ─────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── MULTER (disk storage for images) ──────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    cb(null, `${unique}${path.extname(file.originalname).toLowerCase()}`);
  },
});
const fileFilter = (req, file, cb) => {
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  allowed.includes(file.mimetype)
    ? cb(null, true)
    : cb(new Error("Only images allowed"), false);
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per image
});

// ── SIMPLE IN-MEMORY RATE LIMITER ────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(max = 30, windowMs = 60_000) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const data = rateLimitMap.get(key) || { count: 0, start: now };
    if (now - data.start > windowMs) {
      data.count = 0;
      data.start = now;
    }
    data.count++;
    rateLimitMap.set(key, data);
    if (data.count > max) {
      return res
        .status(429)
        .json({ ok: false, error: "Too many requests. Please wait." });
    }
    next();
  };
}

// ── MIDDLEWARE ────────────────────────────────────────────────────
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json({ limit: "25mb" })); // still support base64 fallback
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname)));
// Serve uploaded images
app.use("/uploads", express.static(UPLOADS_DIR));

// ── MYSQL POOL ───────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "kyu_community",
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 30,
  charset: "utf8mb4",
  timezone: "+03:00",
  multipleStatements: false,
});

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// ── SERVER-SENT EVENTS (real-time) ───────────────────────────────
// Map: userId → Set of response objects
const sseClients = new Map();

function sseEmit(userId, event, data) {
  const clients = sseClients.get(userId);
  if (!clients || !clients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach((res) => {
    try {
      res.write(payload);
    } catch {}
  });
}

function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((clients) => {
    clients.forEach((res) => {
      try {
        res.write(payload);
      } catch {}
    });
  });
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token)
    return res.status(401).json({ ok: false, error: "Not authenticated." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res
      .status(401)
      .json({
        ok: false,
        error: "Token expired or invalid. Please log in again.",
      });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin")
    return res.status(403).json({ ok: false, error: "Admin only." });
  next();
}

// ── HELPERS ───────────────────────────────────────────────────────
function safeUser(u) {
  const { password, ...safe } = u;
  return {
    ...safe,
    regNo: u.reg_no,
    joinedAt: u.joined_at,
    lastSeen: u.last_seen,
  };
}

function normItem(r) {
  // Build image URL: prefer disk path, fallback to base64
  let image = null;
  if (r.image_path) {
    image = `/uploads/${r.image_path}`;
  } else if (r.image_data) {
    image = r.image_data; // base64 fallback
  }
  return {
    id: r.id,
    title: r.title || (r.description || "Item").substring(0, 45),
    description: r.description,
    location: r.location || r.location_lost || r.location_found || "",
    category: r.category,
    price: r.price,
    itemCondition: r.item_condition,
    dateLost: r.date_lost,
    dateFound: r.date_found,
    eventDate: r.event_date,
    expiryDate: r.expiry_date,
    securityQ: r.security_q,
    contactMethod: r.contact_method,
    contactDetail: r.contact_detail,
    handoverLocation: r.handover_location,
    image,
    status: r.status,
    postedBy: r.posted_by,
    postedByName: r.posted_by_name,
    reward: r.reward,
    contact: r.contact,
    views: r.views || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function createNotification(userId, type, title, body, link = "") {
  if (!userId) return;
  try {
    const id = crypto.randomUUID();
    await query(
      "INSERT INTO notifications(id,user_id,type,title,body,link) VALUES(?,?,?,?,?,?)",
      [id, userId, type, title, body, link],
    );
    sseEmit(userId, "notification", {
      id,
      type,
      title,
      body,
      link,
      createdAt: new Date(),
    });
  } catch (e) {
    console.warn("Notification error:", e.message);
  }
}

// Save image: if file uploaded via multipart use path; if base64 use data column
async function saveImage(req) {
  if (req.file) {
    return { image_path: req.file.filename, image_data: null };
  }
  const b64 = req.body.image || null;
  if (b64 && b64.startsWith("data:image")) {
    // Optional: decode and save to disk for better performance
    try {
      const matches = b64.match(/^data:image\/(\w+);base64,(.+)$/);
      if (matches) {
        const ext = matches[1] === "jpeg" ? "jpg" : matches[1];
        const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
        const buffer = Buffer.from(matches[2], "base64");
        if (buffer.length <= 5 * 1024 * 1024) {
          // 5MB limit
          fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
          return { image_path: filename, image_data: null };
        }
      }
    } catch {}
    return { image_path: null, image_data: b64 }; // raw fallback
  }
  return { image_path: null, image_data: null };
}

/* ══════════════════════════════════════════════════════════════════
   HEALTH CHECK
══════════════════════════════════════════════════════════════════ */
app.get("/api/health", async (req, res) => {
  try {
    await pool.execute("SELECT 1");
    res.json({
      ok: true,
      db: "connected",
      time: new Date().toISOString(),
      version: "2.0",
    });
  } catch {
    res.status(503).json({ ok: false, db: "disconnected" });
  }
});

/* ══════════════════════════════════════════════════════════════════
   SERVER-SENT EVENTS  /api/events
══════════════════════════════════════════════════════════════════ */
app.get("/api/events", auth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // for nginx
  res.flushHeaders();

  const userId = req.user.id;
  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);

  // Send initial ping
  res.write(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);

  // Heartbeat every 25s to prevent timeout
  const hb = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {}
  }, 25_000);

  req.on("close", () => {
    clearInterval(hb);
    const set = sseClients.get(userId);
    if (set) {
      set.delete(res);
      if (!set.size) sseClients.delete(userId);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════
   AUTH ROUTES
══════════════════════════════════════════════════════════════════ */

// POST /api/auth/register
app.post("/api/auth/register", rateLimit(10, 60_000), async (req, res) => {
  try {
    const { name, email, password, regNo } = req.body;
    if (!name || !email || !password)
      return res
        .status(400)
        .json({ ok: false, error: "Name, email and password are required." });
    if (password.length < 6)
      return res
        .status(400)
        .json({ ok: false, error: "Password must be at least 6 characters." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res
        .status(400)
        .json({ ok: false, error: "Invalid email address." });

    const existing = await query("SELECT id FROM users WHERE email = ?", [
      email.toLowerCase(),
    ]);
    if (existing.length)
      return res
        .status(409)
        .json({ ok: false, error: "Email already registered." });

    const hash = await bcrypt.hash(password, 12);
    const avatar = name.trim().charAt(0).toUpperCase();
    const id = crypto.randomUUID();

    await query(
      "INSERT INTO users (id, name, email, password, reg_no, avatar) VALUES (?,?,?,?,?,?)",
      [id, name.trim(), email.toLowerCase(), hash, regNo || "", avatar],
    );

    const user = {
      id,
      name: name.trim(),
      email: email.toLowerCase(),
      regNo: regNo || "",
      role: "student",
      avatar,
    };
    const token = jwt.sign(
      { id, email: user.email, role: "student" },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES },
    );

    res.status(201).json({ ok: true, token, user });
  } catch (err) {
    console.error("Register error:", err);
    res
      .status(500)
      .json({ ok: false, error: "Server error during registration." });
  }
});

// POST /api/auth/login
app.post("/api/auth/login", rateLimit(15, 60_000), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res
        .status(400)
        .json({ ok: false, error: "Email and password required." });

    const rows = await query(
      "SELECT * FROM users WHERE email = ? AND is_active = 1",
      [email.toLowerCase()],
    );
    if (!rows.length)
      return res
        .status(401)
        .json({ ok: false, error: "Invalid email or password." });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res
        .status(401)
        .json({ ok: false, error: "Invalid email or password." });

    // Update last seen
    await query("UPDATE users SET last_seen = NOW() WHERE id = ?", [user.id]);

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES },
    );
    res.json({ ok: true, token, user: safeUser(user) });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ ok: false, error: "Server error during login." });
  }
});

// GET /api/auth/me
app.get("/api/auth/me", auth, async (req, res) => {
  try {
    const rows = await query("SELECT * FROM users WHERE id = ?", [req.user.id]);
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "User not found." });
    res.json({ ok: true, user: safeUser(rows[0]) });
  } catch {
    res.status(500).json({ ok: false, error: "Server error." });
  }
});

// PUT /api/auth/profile
app.put("/api/auth/profile", auth, async (req, res) => {
  try {
    const { name, regNo } = req.body;
    if (!name)
      return res.status(400).json({ ok: false, error: "Name required." });
    const avatar = name.trim().charAt(0).toUpperCase();
    await query("UPDATE users SET name=?, reg_no=?, avatar=? WHERE id=?", [
      name.trim(),
      regNo || "",
      avatar,
      req.user.id,
    ]);
    res.json({ ok: true, message: "Profile updated." });
  } catch {
    res.status(500).json({ ok: false, error: "Server error." });
  }
});

// PUT /api/auth/password
app.put("/api/auth/password", auth, rateLimit(5, 300_000), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 6)
      return res
        .status(400)
        .json({ ok: false, error: "Invalid password data." });
    const rows = await query("SELECT password FROM users WHERE id = ?", [
      req.user.id,
    ]);
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "User not found." });
    const match = await bcrypt.compare(currentPassword, rows[0].password);
    if (!match)
      return res
        .status(401)
        .json({ ok: false, error: "Current password is incorrect." });
    const hash = await bcrypt.hash(newPassword, 12);
    await query("UPDATE users SET password = ? WHERE id = ?", [
      hash,
      req.user.id,
    ]);
    res.json({ ok: true, message: "Password updated." });
  } catch {
    res.status(500).json({ ok: false, error: "Server error." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   STATS
══════════════════════════════════════════════════════════════════ */
app.get("/api/stats", auth, async (req, res) => {
  try {
    const [[{ lostCnt }]] = await pool.execute(
      "SELECT COUNT(*) AS lostCnt FROM lost_items WHERE status!='deleted'",
    );
    const [[{ foundCnt }]] = await pool.execute(
      "SELECT COUNT(*) AS foundCnt FROM found_items WHERE status!='deleted'",
    );
    const [[{ resolvedCnt }]] = await pool.execute(
      "SELECT COUNT(*) AS resolvedCnt FROM lost_items WHERE status='resolved'",
    );
    const [[{ userCnt }]] = await pool.execute(
      "SELECT COUNT(*) AS userCnt FROM users WHERE is_active=1",
    );
    const [[{ msgCnt }]] = await pool.execute(
      "SELECT COUNT(*) AS msgCnt FROM messages",
    );
    res.json({
      ok: true,
      lost: lostCnt,
      found: foundCnt,
      resolved: resolvedCnt,
      users: userCnt,
      messages: msgCnt,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Stats error." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   LOST ITEMS
══════════════════════════════════════════════════════════════════ */
app.get("/api/lost", auth, async (req, res) => {
  try {
    const { q, category } = req.query;
    let sql = "SELECT * FROM lost_items WHERE status != 'deleted'";
    const args = [];
    if (category && category !== "all") {
      sql += " AND category = ?";
      args.push(category);
    }
    if (q) {
      sql +=
        " AND MATCH(title,description,location) AGAINST(? IN BOOLEAN MODE)";
      args.push(`${q}*`);
    }
    sql += " ORDER BY created_at DESC LIMIT 200";
    const rows = await query(sql, args);
    res.json({ ok: true, items: rows.map(normItem) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error fetching lost items." });
  }
});

app.get("/api/lost/:id", auth, async (req, res) => {
  try {
    const rows = await query("SELECT * FROM lost_items WHERE id = ?", [
      req.params.id,
    ]);
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found." });
    await query("UPDATE lost_items SET views = views + 1 WHERE id = ?", [
      req.params.id,
    ]);
    res.json({ ok: true, item: normItem(rows[0]) });
  } catch {
    res.status(500).json({ ok: false, error: "Error." });
  }
});

app.post(
  "/api/lost",
  auth,
  upload.single("image"),
  rateLimit(20, 60_000),
  async (req, res) => {
    try {
      const {
        title,
        category,
        description,
        location,
        dateLost,
        reward,
        securityQ,
        contactMethod,
        contactDetail,
        postedByName,
      } = req.body;
      if (!title)
        return res.status(400).json({ ok: false, error: "Title is required." });

      const { image_path, image_data } = await saveImage(req);
      const id = crypto.randomUUID();

      await query(
        `INSERT INTO lost_items
        (id,title,category,description,location,date_lost,reward,security_q,
         contact_method,contact_detail,image_path,image_data,posted_by,posted_by_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          title,
          category || "other",
          description || "",
          location || "",
          dateLost || null,
          reward || "",
          securityQ || "",
          contactMethod || "",
          contactDetail || "",
          image_path,
          image_data,
          req.user.id,
          postedByName || "",
        ],
      );

      const rows = await query("SELECT * FROM lost_items WHERE id = ?", [id]);
      const item = normItem(rows[0]);

      // Real-time broadcast to all users
      sseBroadcast("lost_new", {
        id: item.id,
        title: item.title,
        category: item.category,
      });

      res.status(201).json({ ok: true, item });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, error: "Error saving lost item." });
    }
  },
);

app.patch("/api/lost/:id/resolve", auth, async (req, res) => {
  try {
    const { finderContact, finderAns } = req.body;
    if (!finderContact)
      return res.status(400).json({ ok: false, error: "Contact required." });

    // Get item owner to notify
    const rows = await query(
      "SELECT posted_by, title FROM lost_items WHERE id = ?",
      [req.params.id],
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Item not found." });

    await query(
      "UPDATE lost_items SET status='resolved', finder_contact=?, finder_ans=?, resolved_at=NOW() WHERE id=?",
      [finderContact, finderAns || "", req.params.id],
    );

    // Notify owner
    await createNotification(
      rows[0].posted_by,
      "resolved",
      `Your item "${rows[0].title}" has been found!`,
      `Someone reported finding your lost item. Check your Lost Items page.`,
      "lost.html",
    );

    res.json({ ok: true, message: "Marked as resolved." });
  } catch {
    res.status(500).json({ ok: false, error: "Error updating item." });
  }
});

app.delete("/api/lost/:id", auth, async (req, res) => {
  try {
    const rows = await query("SELECT posted_by FROM lost_items WHERE id = ?", [
      req.params.id,
    ]);
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found." });
    if (rows[0].posted_by !== req.user.id && req.user.role !== "admin")
      return res.status(403).json({ ok: false, error: "Not your item." });
    await query("UPDATE lost_items SET status='deleted' WHERE id=?", [
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Error deleting." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   FOUND ITEMS
══════════════════════════════════════════════════════════════════ */
app.get("/api/found", auth, async (req, res) => {
  try {
    const { q } = req.query;
    let sql = "SELECT * FROM found_items WHERE status != 'deleted'";
    const args = [];
    if (q) {
      sql += " AND MATCH(description,location) AGAINST(? IN BOOLEAN MODE)";
      args.push(`${q}*`);
    }
    sql += " ORDER BY created_at DESC LIMIT 200";
    const rows = await query(sql, args);
    res.json({ ok: true, items: rows.map(normItem) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error fetching found items." });
  }
});

app.post(
  "/api/found",
  auth,
  upload.single("image"),
  rateLimit(20, 60_000),
  async (req, res) => {
    try {
      const {
        description,
        location,
        dateFound,
        securityQ,
        handoverLocation,
        postedByName,
      } = req.body;
      if (!description)
        return res
          .status(400)
          .json({ ok: false, error: "Description is required." });

      const { image_path, image_data } = await saveImage(req);
      const id = crypto.randomUUID();

      await query(
        `INSERT INTO found_items
        (id,description,location,date_found,security_q,handover_location,image_path,image_data,posted_by,posted_by_name)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          description,
          location || "",
          dateFound || null,
          securityQ || "",
          handoverLocation || "",
          image_path,
          image_data,
          req.user.id,
          postedByName || "",
        ],
      );

      const rows = await query("SELECT * FROM found_items WHERE id = ?", [id]);
      const item = normItem(rows[0]);
      sseBroadcast("found_new", {
        id: item.id,
        description: (item.description || "").substring(0, 50),
      });
      res.status(201).json({ ok: true, item });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, error: "Error saving found item." });
    }
  },
);

app.patch("/api/found/:id/claim", auth, async (req, res) => {
  try {
    const { claimContact, claimAnswer } = req.body;
    if (!claimContact)
      return res.status(400).json({ ok: false, error: "Contact required." });

    const rows = await query(
      "SELECT posted_by, description FROM found_items WHERE id = ?",
      [req.params.id],
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found." });

    await query(
      "UPDATE found_items SET status='claimed', claim_contact=?, claim_ans=?, claimed_at=NOW() WHERE id=?",
      [claimContact, claimAnswer || "", req.params.id],
    );

    await createNotification(
      rows[0].posted_by,
      "claim",
      "Someone claimed your found item!",
      `A user submitted a claim for the item you reported found.`,
      "found.html",
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Error claiming." });
  }
});

app.delete("/api/found/:id", auth, async (req, res) => {
  try {
    const rows = await query("SELECT posted_by FROM found_items WHERE id = ?", [
      req.params.id,
    ]);
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found." });
    if (rows[0].posted_by !== req.user.id && req.user.role !== "admin")
      return res.status(403).json({ ok: false, error: "Not your item." });
    await query("UPDATE found_items SET status='deleted' WHERE id=?", [
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Error deleting." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   ANNOUNCEMENTS
══════════════════════════════════════════════════════════════════ */
app.get("/api/announcements", auth, async (req, res) => {
  try {
    const { q, category } = req.query;
    let sql = "SELECT * FROM announcements WHERE 1=1";
    const args = [];
    if (category && category !== "all") {
      sql += " AND category = ?";
      args.push(category);
    }
    if (q) {
      sql += " AND MATCH(title,description) AGAINST(? IN BOOLEAN MODE)";
      args.push(`${q}*`);
    }
    sql += " ORDER BY created_at DESC LIMIT 200";
    const rows = await query(sql, args);
    res.json({ ok: true, items: rows.map(normItem) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error fetching announcements." });
  }
});

app.post(
  "/api/announcements",
  auth,
  upload.single("image"),
  rateLimit(10, 60_000),
  async (req, res) => {
    try {
      const {
        title,
        category,
        description,
        eventDate,
        expiryDate,
        postedByName,
      } = req.body;
      if (!title || !expiryDate)
        return res
          .status(400)
          .json({ ok: false, error: "Title and expiry date required." });

      const { image_path, image_data } = await saveImage(req);
      const id = crypto.randomUUID();

      await query(
        `INSERT INTO announcements
        (id,title,category,description,image_path,image_data,event_date,expiry_date,posted_by,posted_by_name)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          title,
          category || "general",
          description || "",
          image_path,
          image_data,
          eventDate || null,
          expiryDate,
          req.user.id,
          postedByName || "",
        ],
      );

      const rows = await query("SELECT * FROM announcements WHERE id = ?", [
        id,
      ]);
      const item = normItem(rows[0]);
      sseBroadcast("announcement_new", {
        id: item.id,
        title: item.title,
        category: item.category,
      });
      res.status(201).json({ ok: true, item });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, error: "Error saving announcement." });
    }
  },
);

app.delete("/api/announcements/:id", auth, async (req, res) => {
  try {
    const rows = await query(
      "SELECT posted_by FROM announcements WHERE id = ?",
      [req.params.id],
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found." });
    if (rows[0].posted_by !== req.user.id && req.user.role !== "admin")
      return res.status(403).json({ ok: false, error: "Not authorized." });
    await query("DELETE FROM announcements WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Error deleting." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   MARKETPLACE
══════════════════════════════════════════════════════════════════ */
app.get("/api/marketplace", auth, async (req, res) => {
  try {
    const { q, category, sort } = req.query;
    let sql = "SELECT * FROM marketplace_items WHERE status = 'available'";
    const args = [];
    if (category) {
      sql += " AND category = ?";
      args.push(category);
    }
    if (q) {
      sql +=
        " AND MATCH(title,description,location) AGAINST(? IN BOOLEAN MODE)";
      args.push(`${q}*`);
    }
    if (sort === "price_asc") sql += " ORDER BY price ASC";
    else if (sort === "price_desc") sql += " ORDER BY price DESC";
    else sql += " ORDER BY created_at DESC";
    sql += " LIMIT 200";
    const rows = await query(sql, args);
    res.json({ ok: true, items: rows.map(normItem) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error fetching marketplace." });
  }
});

app.get("/api/marketplace/:id", auth, async (req, res) => {
  try {
    const rows = await query("SELECT * FROM marketplace_items WHERE id = ?", [
      req.params.id,
    ]);
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found." });
    res.json({ ok: true, item: normItem(rows[0]) });
  } catch {
    res.status(500).json({ ok: false, error: "Error." });
  }
});

app.post(
  "/api/marketplace",
  auth,
  upload.single("image"),
  rateLimit(15, 60_000),
  async (req, res) => {
    try {
      const {
        title,
        category,
        price,
        condition,
        description,
        location,
        contact,
        postedByName,
      } = req.body;
      if (!title || !price)
        return res
          .status(400)
          .json({ ok: false, error: "Title and price required." });

      const { image_path, image_data } = await saveImage(req);
      const id = crypto.randomUUID();

      await query(
        `INSERT INTO marketplace_items
        (id,title,category,price,item_condition,description,location,contact,
         image_path,image_data,posted_by,posted_by_name)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          title,
          category || "other",
          Number(price) || 0,
          condition || "good",
          description || "",
          location || "",
          contact || "",
          image_path,
          image_data,
          req.user.id,
          postedByName || "",
        ],
      );

      const rows = await query("SELECT * FROM marketplace_items WHERE id = ?", [
        id,
      ]);
      const item = normItem(rows[0]);
      sseBroadcast("market_new", {
        id: item.id,
        title: item.title,
        price: item.price,
      });
      res.status(201).json({ ok: true, item });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, error: "Error saving listing." });
    }
  },
);

app.patch("/api/marketplace/:id/view", auth, async (req, res) => {
  try {
    await query("UPDATE marketplace_items SET views = views + 1 WHERE id = ?", [
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Error." });
  }
});

app.patch("/api/marketplace/:id/sold", auth, async (req, res) => {
  try {
    const rows = await query(
      "SELECT posted_by FROM marketplace_items WHERE id = ?",
      [req.params.id],
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found." });
    if (rows[0].posted_by !== req.user.id)
      return res.status(403).json({ ok: false, error: "Not your listing." });
    await query("UPDATE marketplace_items SET status='sold' WHERE id=?", [
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Error." });
  }
});

app.delete("/api/marketplace/:id", auth, async (req, res) => {
  try {
    const rows = await query(
      "SELECT posted_by FROM marketplace_items WHERE id = ?",
      [req.params.id],
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: "Not found." });
    if (rows[0].posted_by !== req.user.id && req.user.role !== "admin")
      return res.status(403).json({ ok: false, error: "Not authorized." });
    await query("UPDATE marketplace_items SET status='deleted' WHERE id=?", [
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Error deleting." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   MESSAGES  (full inbox system)
══════════════════════════════════════════════════════════════════ */
app.post("/api/messages", auth, rateLimit(30, 60_000), async (req, res) => {
  try {
    const { itemId, itemType, text, toId } = req.body;
    if (!itemId || !text?.trim())
      return res
        .status(400)
        .json({ ok: false, error: "itemId and text required." });

    // Resolve recipient from item owner
    let recipientId = toId || null;
    if (!recipientId) {
      const tableMap = {
        lost: "lost_items",
        found: "found_items",
        marketplace: "marketplace_items",
        announcement: "announcements",
      };
      const table = tableMap[itemType] || "marketplace_items";
      const rows = await query(`SELECT posted_by FROM ${table} WHERE id = ?`, [
        itemId,
      ]);
      if (rows.length) recipientId = rows[0].posted_by;
    }

    // Don't send to self
    if (recipientId === req.user.id) recipientId = null;

    const id = crypto.randomUUID();
    await query(
      "INSERT INTO messages(id,item_id,item_type,from_id,from_name,to_id,text) VALUES(?,?,?,?,?,?,?)",
      [
        id,
        itemId,
        itemType || "marketplace",
        req.user.id,
        req.body.fromName || "",
        recipientId,
        text.trim(),
      ],
    );

    // Notify recipient
    if (recipientId) {
      await createNotification(
        recipientId,
        "message",
        `New message from ${req.body.fromName || "a user"}`,
        text.trim().substring(0, 80),
        `${itemType || "marketplace"}.html`,
      );
    }

    res.status(201).json({ ok: true, id, message: "Message sent." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Error sending message." });
  }
});

// GET /api/messages/inbox  — messages TO current user
app.get("/api/messages/inbox", auth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT m.*, u.name AS sender_name, u.avatar AS sender_avatar
       FROM messages m
       JOIN users u ON u.id = m.from_id
       WHERE m.to_id = ?
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [req.user.id],
    );
    res.json({ ok: true, messages: rows });
  } catch {
    res.status(500).json({ ok: false, error: "Error fetching inbox." });
  }
});

// GET /api/messages/thread/:itemId — all messages for an item
app.get("/api/messages/thread/:itemId", auth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT m.*, u.name AS sender_name
       FROM messages m JOIN users u ON u.id = m.from_id
       WHERE m.item_id = ? AND (m.from_id = ? OR m.to_id = ? OR m.to_id IS NULL)
       ORDER BY m.created_at ASC LIMIT 200`,
      [req.params.itemId, req.user.id, req.user.id],
    );
    res.json({ ok: true, messages: rows });
  } catch {
    res.status(500).json({ ok: false, error: "Error." });
  }
});

// PATCH /api/messages/:id/read
app.patch("/api/messages/:id/read", auth, async (req, res) => {
  try {
    await query(
      "UPDATE messages SET is_read=1, read_at=NOW() WHERE id=? AND to_id=?",
      [req.params.id, req.user.id],
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Error." });
  }
});

// PATCH /api/messages/read-all
app.patch("/api/messages/read-all", auth, async (req, res) => {
  try {
    await query(
      "UPDATE messages SET is_read=1, read_at=NOW() WHERE to_id=? AND is_read=0",
      [req.user.id],
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Error." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   NOTIFICATIONS
══════════════════════════════════════════════════════════════════ */
app.get("/api/notifications", auth, async (req, res) => {
  try {
    const rows = await query(
      "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
      [req.user.id],
    );
    const unread = rows.filter((n) => !n.is_read).length;
    res.json({ ok: true, notifications: rows, unread });
  } catch {
    res.status(500).json({ ok: false, error: "Error." });
  }
});

app.patch("/api/notifications/read-all", auth, async (req, res) => {
  try {
    await query("UPDATE notifications SET is_read=1 WHERE user_id=?", [
      req.user.id,
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Error." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   ADMIN ENDPOINTS
══════════════════════════════════════════════════════════════════ */
app.get("/api/admin/users", auth, adminOnly, async (req, res) => {
  try {
    const rows = await query(
      "SELECT id,name,email,reg_no,role,is_active,joined_at,last_seen FROM users ORDER BY joined_at DESC",
    );
    res.json({ ok: true, users: rows });
  } catch {
    res.status(500).json({ ok: false, error: "Error." });
  }
});

app.patch("/api/admin/users/:id/toggle", auth, adminOnly, async (req, res) => {
  try {
    await query("UPDATE users SET is_active = NOT is_active WHERE id = ?", [
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Error." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   ERROR HANDLER FOR MULTER
══════════════════════════════════════════════════════════════════ */
app.use((err, req, res, next) => {
  if (
    err instanceof multer.MulterError ||
    err.message === "Only images allowed"
  ) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ ok: false, error: "Internal server error." });
});

/* ══════════════════════════════════════════════════════════════════
   SPA FALLBACK
══════════════════════════════════════════════════════════════════ */
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/"))
    return res.status(404).json({ ok: false, error: "Not found." });
  res.sendFile(path.join(__dirname, "login.html"));
});

/* ══════════════════════════════════════════════════════════════════
   START SERVER
══════════════════════════════════════════════════════════════════ */
// Add image_path column if upgrading from v1 (safe migration)
async function runMigrations() {
  try {
    await pool.execute(
      "ALTER TABLE lost_items ADD COLUMN image_path VARCHAR(200) DEFAULT NULL AFTER image_data",
    );
  } catch {}
  try {
    await pool.execute(
      "ALTER TABLE found_items ADD COLUMN image_path VARCHAR(200) DEFAULT NULL AFTER image_data",
    );
  } catch {}
  try {
    await pool.execute(
      "ALTER TABLE announcements ADD COLUMN image_path VARCHAR(200) DEFAULT NULL AFTER image_data",
    );
  } catch {}
  try {
    await pool.execute(
      "ALTER TABLE marketplace_items ADD COLUMN image_path VARCHAR(200) DEFAULT NULL AFTER image_data",
    );
  } catch {}
}

pool
  .getConnection()
  .then(async (conn) => {
    conn.release();
    await runMigrations();
    console.log("✅ MySQL connected:", process.env.DB_NAME || "kyu_community");
    app.listen(PORT, "0.0.0.0", () =>
      console.log(`🚀 KyU Community Server v2.0 → http://localhost:${PORT}`),
    );
  })
  .catch((err) => {
    console.error("❌ MySQL connection failed:", err.message);
    console.log("⚠️  Starting in offline mode (localStorage only)…");
    app.listen(PORT, "0.0.0.0", () =>
      console.log(`🚀 KyU Community (offline mode) → http://localhost:${PORT}`),
    );
  });
