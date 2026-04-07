/* ================================================================
   KyU Community — app.js  v2.0  (Frontend Core)
   ✅ Connects to Node/MySQL backend at /api (same-origin)
   ✅ Falls back to localStorage when backend is offline
   ✅ JWT auth · Real-time SSE notifications · Inbox system
   ✅ Image upload: multipart/form-data (disk) + base64 fallback
   ✅ Rate-limit-aware · mobile-first · accessible
   ================================================================ */

const KyU = (() => {
  "use strict";
  const API = "/api";
  let _online = null;
  let _sseConn = null;
  let _unreadCount = 0;

  // ── IMAGE UTILITIES ──────────────────────────────────────────────
  function resizeImage(file, maxW = 900, quality = 0.78) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxW / img.width);
          const canvas = document.createElement("canvas");
          canvas.width = img.width * scale;
          canvas.height = img.height * scale;
          canvas
            .getContext("2d")
            .drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Upload file via multipart (preferred — saves to disk, faster loads)
  async function uploadImage(file) {
    const token = LS.get("kyu_jwt");
    if (!token || !(await isOnline())) {
      return resizeImage(file); // fallback: base64
    }
    const fd = new FormData();
    fd.append("image", file);
    try {
      const res = await fetch(`${API}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json();
      return data.url || (await resizeImage(file));
    } catch {
      return resizeImage(file);
    }
  }

  function svgPlaceholder(text = "") {
    const t = String(text).replace(
      /[<>&"]/g,
      (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c],
    );
    return `data:image/svg+xml;base64,${btoa(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220" style="background:#e9ecef">
        <text x="50%" y="50%" text-anchor="middle" dy=".3em"
          font-family="sans-serif" fill="#adb5bd" font-size="15">${t || "No Image"}</text>
      </svg>`,
    )}`;
  }

  // ── LOCAL STORAGE ────────────────────────────────────────────────
  const LS = {
    get: (k) => {
      try {
        return JSON.parse(localStorage.getItem(k));
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (e) {
        console.warn(e);
      }
    },
    saveItem(type, item) {
      const list = this.get(`kyu_${type}`) || [];
      item.id =
        Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      item.createdAt = new Date().toISOString();
      list.unshift(item);
      this.set(`kyu_${type}`, list);
      return item;
    },
    getItems: (type) => LS.get(`kyu_${type}`) || [],
    deleteItem: (type, id) => {
      LS.set(
        `kyu_${type}`,
        (LS.get(`kyu_${type}`) || []).filter((i) => i.id !== id),
      );
    },
    updateItem(type, id, patch) {
      const list = LS.get(`kyu_${type}`) || [];
      const idx = list.findIndex((i) => i.id === id);
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...patch };
        LS.set(`kyu_${type}`, list);
      }
    },
  };

  // ── HTTP CLIENT ──────────────────────────────────────────────────
  async function http(method, endpoint, body = null, isForm = false) {
    const token = LS.get("kyu_jwt");
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    if (!isForm) headers["Content-Type"] = "application/json";
    const res = await fetch(`${API}${endpoint}`, {
      method,
      headers,
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      LS.set("kyu_jwt", null);
      LS.set("kyu_user", null);
      window.location.href = "login.html";
      return {};
    }
    return res.json();
  }

  async function isOnline() {
    if (_online !== null) return _online;
    try {
      const r = await fetch(`${API}/health`, {
        signal: AbortSignal.timeout(2500),
      });
      _online = r.ok;
    } catch {
      _online = false;
    }
    setTimeout(() => {
      _online = null;
    }, 30_000); // recheck every 30s
    return _online;
  }

  // ── SSE (real-time notifications) ────────────────────────────────
  function startSSE() {
    const token = LS.get("kyu_jwt");
    if (!token || _sseConn) return;
    try {
      // EventSource doesn't support custom headers; pass token as query param
      const url = `${API}/events?token=${encodeURIComponent(token)}`;
      // We use fetch+ReadableStream instead for header support
      fetchSSE(token);
    } catch {}
  }

  async function fetchSSE(token) {
    try {
      const res = await fetch(`${API}/events`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      _sseConn = reader;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        let event = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              handleSSEEvent(event, data);
            } catch {}
          }
        }
      }
    } catch {
      // Reconnect after 5s if connection drops
      setTimeout(() => {
        _sseConn = null;
        startSSE();
      }, 5_000);
    }
  }

  function handleSSEEvent(event, data) {
    switch (event) {
      case "notification":
        _unreadCount++;
        updateNotifBadge();
        ui.toast(data.title || "New notification", "info");
        break;
      case "lost_new":
      case "found_new":
      case "market_new":
      case "announcement_new":
        // Trigger page refresh hint if user is on that page
        document.dispatchEvent(
          new CustomEvent("kyu:new_item", { detail: { event, data } }),
        );
        break;
    }
  }

  function updateNotifBadge() {
    document.querySelectorAll(".kyu-notif-badge").forEach((b) => {
      b.textContent = _unreadCount > 9 ? "9+" : String(_unreadCount);
      b.style.display = _unreadCount > 0 ? "flex" : "none";
    });
  }

  // ── ENDPOINTS MAP ─────────────────────────────────────────────────
  const ENDPOINTS = {
    lost: "lost",
    found: "found",
    marketplace: "marketplace",
    announcements: "announcements",
  };

  // ── AUTH MODULE ───────────────────────────────────────────────────
  const auth = {
    currentUser: () => LS.get("kyu_user"),

    requireAuth() {
      if (!this.currentUser()) {
        window.location.href = "login.html";
        return false;
      }
      return true;
    },

    async login(email, password) {
      try {
        const data = await http("POST", "/auth/login", { email, password });
        if (data.ok) {
          LS.set("kyu_jwt", data.token);
          LS.set("kyu_user", data.user);
          _online = true;
        }
        return data;
      } catch {
        return { ok: false, error: "Cannot reach server." };
      }
    },

    async signup({ name, email, password, regNo }) {
      try {
        const data = await http("POST", "/auth/register", {
          name,
          email,
          password,
          regNo,
        });
        if (data.ok) {
          LS.set("kyu_jwt", data.token);
          LS.set("kyu_user", data.user);
          _online = true;
        }
        return data;
      } catch {
        return { ok: false, error: "Cannot reach server." };
      }
    },

    logout() {
      LS.set("kyu_jwt", null);
      LS.set("kyu_user", null);
      _sseConn?.cancel?.();
      _sseConn = null;
      window.location.href = "login.html";
    },
  };

  // ── STORAGE MODULE ────────────────────────────────────────────────
  const storage = {
    get: LS.get.bind(LS),
    set: LS.set.bind(LS),

    async getItems(type) {
      if (await isOnline()) {
        try {
          const ep = ENDPOINTS[type] || type;
          const data = await http("GET", `/${ep}`);
          if (data.ok && Array.isArray(data.items)) {
            LS.set(`kyu_${type}`, data.items); // cache
            return data.items;
          }
        } catch (e) {
          console.warn("API getItems failed:", e.message);
        }
      }
      return LS.getItems(type);
    },

    async saveItem(type, item) {
      if (await isOnline()) {
        try {
          const ep = ENDPOINTS[type] || type;
          // If item has a File image, use multipart
          let body = item;
          let isForm = false;
          if (item._file) {
            const fd = new FormData();
            Object.entries(item).forEach(([k, v]) => {
              if (k !== "_file" && v != null) fd.append(k, v);
            });
            fd.append("image", item._file);
            body = fd;
            isForm = true;
          }
          const data = await http("POST", `/${ep}`, body, isForm);
          if (data.ok && data.item) {
            const list = LS.get(`kyu_${type}`) || [];
            list.unshift(data.item);
            LS.set(`kyu_${type}`, list);
            return data.item;
          }
        } catch (e) {
          console.warn("API saveItem failed:", e.message);
        }
      }
      return LS.saveItem(type, item);
    },

    async deleteItem(type, id) {
      if (await isOnline()) {
        try {
          const ep = ENDPOINTS[type] || type;
          await http("DELETE", `/${ep}/${id}`);
        } catch (e) {
          console.warn("API delete failed:", e.message);
        }
      }
      LS.deleteItem(type, id);
    },

    async updateItem(type, id, patch) {
      if (await isOnline()) {
        try {
          const ep = ENDPOINTS[type] || type;
          if (type === "lost" && patch.status === "resolved")
            return await http("PATCH", `/${ep}/${id}/resolve`, {
              finderContact: patch.finderContact,
              finderAns: patch.finderAns,
            });
          if (type === "found" && patch.status === "claimed")
            return await http("PATCH", `/${ep}/${id}/claim`, {
              claimContact: patch.claimContact,
              claimAnswer: patch.claimAns,
            });
          if (type === "marketplace" && patch.views !== undefined)
            return await http("PATCH", `/${ep}/${id}/view`, {});
        } catch (e) {
          console.warn("API update failed:", e.message);
        }
      }
      LS.updateItem(type, id, patch);
    },

    async sendMessage(itemId, itemType, text) {
      const user = auth.currentUser();
      if (await isOnline()) {
        try {
          return await http("POST", "/messages", {
            itemId,
            itemType,
            text,
            fromName: user?.name || "",
          });
        } catch (e) {
          console.warn(e.message);
        }
      }
      const msgs = LS.get("kyu_messages") || [];
      msgs.push({
        id: Date.now().toString(),
        itemId,
        itemType,
        from: user?.id,
        fromName: user?.name,
        text,
        at: new Date().toISOString(),
      });
      LS.set("kyu_messages", msgs);
      return { ok: true };
    },

    async getInbox() {
      if (await isOnline()) {
        try {
          const data = await http("GET", "/messages/inbox");
          if (data.ok) return data.messages;
        } catch {}
      }
      return [];
    },

    async getNotifications() {
      if (await isOnline()) {
        try {
          const data = await http("GET", "/notifications");
          if (data.ok) {
            _unreadCount = data.unread;
            updateNotifBadge();
            return data;
          }
        } catch {}
      }
      return { notifications: [], unread: 0 };
    },

    async markAllRead() {
      if (await isOnline()) {
        try {
          await http("PATCH", "/notifications/read-all");
          await http("PATCH", "/messages/read-all");
          _unreadCount = 0;
          updateNotifBadge();
        } catch {}
      }
    },
  };

  // ── UI HELPERS ────────────────────────────────────────────────────
  const ui = {
    toast(msg = "", type = "success", duration = 3500) {
      const icons = {
        success: "circle-check",
        error: "circle-xmark",
        info: "circle-info",
        warning: "triangle-exclamation",
      };
      const colours = {
        success: "#0B3B2F",
        error: "#dc3545",
        info: "#0d6efd",
        warning: "#e09100",
      };
      const t = document.createElement("div");
      t.innerHTML = `<i class="fa-solid fa-${icons[type] || "circle-check"}"></i> ${msg}`;
      Object.assign(t.style, {
        position: "fixed",
        bottom: "24px",
        right: "24px",
        zIndex: "99999",
        background: colours[type] || colours.success,
        color: "#fff",
        padding: ".85rem 1.3rem",
        borderRadius: "12px",
        display: "flex",
        alignItems: "center",
        gap: ".55rem",
        maxWidth: "340px",
        lineHeight: "1.4",
        fontFamily: "Inter,sans-serif",
        fontWeight: "500",
        fontSize: ".95rem",
        boxShadow: "0 8px 24px rgba(0,0,0,.25)",
        animation: "kyu-slide-in .35s cubic-bezier(.22,.68,0,1.2)",
      });
      document.body.appendChild(t);
      setTimeout(() => {
        t.style.transition = ".4s";
        t.style.opacity = "0";
        t.style.transform = "translateX(120%)";
        setTimeout(() => t.remove(), 400);
      }, duration);
    },

    confirm: (msg) => window.confirm(msg),

    timeAgo(d) {
      if (!d) return "—";
      const m = Math.floor((Date.now() - new Date(d)) / 60000);
      if (m < 1) return "just now";
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      const dy = Math.floor(h / 24);
      if (dy < 7) return `${dy}d ago`;
      return new Date(d).toLocaleDateString("en-KE", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    },

    fmtDate(d) {
      if (!d) return "—";
      return new Date(d).toLocaleDateString("en-KE", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    },

    animateCounter(el, target, ms = 1200) {
      if (!el) return;
      let s = 0;
      const step = (ts) => {
        if (!s) s = ts;
        const p = Math.min((ts - s) / ms, 1);
        el.textContent = Math.floor(p * target);
        if (p < 1) requestAnimationFrame(step);
        else el.textContent = target;
      };
      requestAnimationFrame(step);
    },

    modal(title, body, footer = "") {
      document.getElementById("kyuModal")?.remove();
      const m = document.createElement("div");
      m.id = "kyuModal";
      m.className = "kyu-modal-backdrop";
      m.setAttribute("role", "dialog");
      m.setAttribute("aria-modal", "true");
      m.setAttribute("aria-label", title);
      m.innerHTML = `
        <div class="kyu-modal-box" id="kyuModalBox">
          <div class="kyu-modal-head">
            <h4>${title}</h4>
            <button class="kyu-modal-close" onclick="document.getElementById('kyuModal').remove()" aria-label="Close">×</button>
          </div>
          <div class="kyu-modal-body">${body}</div>
          ${footer ? `<div class="kyu-modal-foot">${footer}</div>` : ""}
        </div>`;
      m.addEventListener("click", (e) => {
        if (e.target === m) m.remove();
      });
      // Close on ESC
      const onKey = (e) => {
        if (e.key === "Escape") {
          m.remove();
          document.removeEventListener("keydown", onKey);
        }
      };
      document.addEventListener("keydown", onKey);
      document.body.appendChild(m);
      requestAnimationFrame(() =>
        document.getElementById("kyuModalBox")?.classList.add("open"),
      );
    },

    emptyState(el, icon, title, sub) {
      el.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:4rem 1.5rem">
          <i class="fa-solid fa-${icon}" style="font-size:3rem;color:#ccc;display:block;margin-bottom:1rem"></i>
          <h3 style="color:#aaa;margin-bottom:.5rem;font-family:Inter,sans-serif">${title}</h3>
          <p style="color:#bbb;font-family:Inter,sans-serif">${sub}</p>
        </div>`;
    },

    injectUserNav() {
      const user = auth.currentUser();
      if (!user) return;

      // Start SSE after auth
      startSSE();

      // Load unread count
      storage.getNotifications().catch(() => {});

      document.querySelectorAll(".header-buttons").forEach((hb) => {
        if (hb.querySelector(".kyu-avatar")) return;
        const w = document.createElement("div");
        w.className = "kyu-user-wrap";
        const initial = (user.name || "U").charAt(0).toUpperCase();
        w.innerHTML = `
          <button class="kyu-notif-btn" onclick="KyU.ui._notifPanel()" title="Notifications" aria-label="Notifications">
            <i class="fa-regular fa-bell"></i>
            <span class="kyu-notif-badge" style="display:none">0</span>
          </button>
          <div class="kyu-avatar" title="${initial}" onclick="KyU.ui._profileModal()" style="cursor:pointer">
            <span class="kyu-avatar-name">${(user.name || "").split(" ")[0] || "User"}</span>
          </div>`;
        hb.prepend(w);
      });

      // Online/offline indicator
      isOnline().then((online) => {
        const b = document.createElement("div");
        b.className = "kyu-online-badge";
        b.textContent = online ? "🟢 Live" : "🟡 Offline";
        document.body.appendChild(b);
        setTimeout(() => {
          b.style.opacity = "0";
          setTimeout(() => b.remove(), 500);
        }, 2800);
      });
    },

    async _notifPanel() {
      const { notifications, unread } = await storage.getNotifications();
      const listHtml = notifications.length
        ? notifications
            .map(
              (n) => `
          <div style="display:flex;gap:.8rem;align-items:flex-start;padding:.85rem 0;border-bottom:1px solid #f0f0f0;${n.is_read ? "opacity:.6" : ""}">
            <div style="width:36px;height:36px;background:${n.is_read ? "#e9ecef" : "#0B3B2F"};border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <i class="fa-solid fa-bell" style="color:${n.is_read ? "#999" : "#F4A300"};font-size:.85rem"></i>
            </div>
            <div style="flex:1">
              <div style="font-weight:600;color:#333;font-size:.9rem;font-family:Inter,sans-serif">${n.title}</div>
              <div style="color:#777;font-size:.82rem;margin-top:.15rem;font-family:Inter,sans-serif">${n.body || ""}</div>
              <div style="color:#bbb;font-size:.75rem;margin-top:.2rem;font-family:Inter,sans-serif">${this.timeAgo(n.created_at)}</div>
            </div>
          </div>`,
            )
            .join("")
        : `<p style="text-align:center;color:#aaa;padding:2rem;font-family:Inter,sans-serif">No notifications yet</p>`;

      this.modal(
        "Notifications",
        `<div style="max-height:400px;overflow-y:auto">${listHtml}</div>`,
        unread > 0
          ? `<button onclick="KyU.storage.markAllRead().then(()=>document.getElementById('kyuModal')?.remove())" style="background:#0B3B2F;color:#fff;border:none;padding:.65rem 1.5rem;border-radius:50px;font-weight:600;cursor:pointer;font-family:Inter,sans-serif;font-size:.9rem">
               <i class="fa-solid fa-check-double"></i> Mark All Read
             </button>`
          : "",
      );
    },

    _profileModal() {
      const user = auth.currentUser();
      if (!user) return;
      this.modal(
        "My Profile",
        `
        <div style="text-align:center;margin-bottom:1.2rem">
          <div class="kyu-profile-avatar">${(user.name || "U").charAt(0).toUpperCase()}</div>
          <h3 style="color:#0B3B2F;font-family:Inter,sans-serif;margin:.3rem 0 .2rem">${user.name || ""}</h3>
          <p style="color:#888;font-size:.88rem;font-family:Inter,sans-serif">${user.email || ""}</p>
          ${user.regNo || user.reg_no ? `<p style="color:#F4A300;font-size:.82rem;font-weight:600;font-family:Inter,sans-serif">${user.regNo || user.reg_no}</p>` : ""}
          <span style="background:#e9ecef;color:#555;font-size:.73rem;font-weight:700;padding:.22rem .65rem;border-radius:50px;font-family:Inter,sans-serif">${(user.role || "student").toUpperCase()}</span>
        </div>
        <hr style="margin:1rem 0">
        <p style="text-align:center;color:#aaa;font-size:.8rem;font-family:Inter,sans-serif">
          Member since ${this.fmtDate(user.joinedAt || user.joined_at || new Date())}
        </p>`,
        `<button class="kyu-btn-danger" onclick="KyU.auth.logout()">
           <i class="fa-solid fa-right-from-bracket"></i> Logout
         </button>`,
      );
    },
  };

  // ── INJECT GLOBAL CSS ─────────────────────────────────────────────
  const css = document.createElement("style");
  css.textContent = `
    *,::after,::before{box-sizing:border-box}
    @keyframes kyu-slide-in{from{transform:translateX(110%);opacity:0}to{transform:translateX(0);opacity:1}}
    @keyframes kyu-pop-in  {from{transform:scale(.88) translateY(18px);opacity:0}to{transform:scale(1) translateY(0);opacity:1}}
    @keyframes kyu-fade-in {from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}

    /* Modal */
    .kyu-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9998;display:flex;align-items:center;justify-content:center;padding:1rem;backdrop-filter:blur(4px)}
    .kyu-modal-box{background:#fff;border-radius:18px;max-width:580px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.35);opacity:0;transform:scale(.9) translateY(18px);transition:.3s cubic-bezier(.22,.68,0,1.2)}
    .kyu-modal-box.open{opacity:1;transform:scale(1) translateY(0)}
    .kyu-modal-head{background:#0B3B2F;color:#fff;padding:1.3rem 1.8rem;border-radius:18px 18px 0 0;display:flex;justify-content:space-between;align-items:center}
    .kyu-modal-head h4{margin:0;font-family:Inter,sans-serif;font-size:1.05rem;font-weight:700}
    .kyu-modal-close{background:none;border:none;color:#fff;font-size:1.7rem;cursor:pointer;line-height:1;padding:0;opacity:.8;transition:.2s}
    .kyu-modal-close:hover{opacity:1;transform:scale(1.15)}
    .kyu-modal-body{padding:1.8rem;font-family:Inter,sans-serif}
    .kyu-modal-foot{padding:0 1.8rem 1.8rem;display:flex;gap:.8rem;flex-wrap:wrap}

    /* Avatar & nav */
    .kyu-user-wrap{display:flex;align-items:center;gap:.5rem;margin-right:.4rem}
    .kyu-avatar{display:flex;align-items:center;gap:.45rem;background:#F4A300;border-radius:50px;padding:.32rem .85rem .32rem .4rem;transition:.25s;font-family:Inter,sans-serif;cursor:pointer;border:none}
    .kyu-avatar:hover{transform:scale(1.05);box-shadow:0 4px 16px rgba(0,0,0,.2)}
    .kyu-avatar::before{content:attr(title);display:inline-flex;width:26px;height:26px;background:#0B3B2F;color:#F4A300;border-radius:50%;align-items:center;justify-content:center;font-weight:700;font-size:.9rem;flex-shrink:0}
    .kyu-avatar-name{font-size:.83rem;font-weight:600;color:#0B3B2F}
    .kyu-profile-avatar{width:68px;height:68px;background:#F4A300;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:2.1rem;font-weight:700;color:#0B3B2F;margin:0 auto .8rem;box-shadow:0 8px 24px rgba(244,163,0,.35)}

    /* Notification button */
    .kyu-notif-btn{position:relative;background:rgba(255,255,255,.15);border:none;color:#fff;width:36px;height:36px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.25s;font-size:.95rem}
    .kyu-notif-btn:hover{background:rgba(255,255,255,.25)}
    .kyu-notif-badge{position:absolute;top:-4px;right:-4px;background:#dc3545;color:#fff;font-size:.6rem;font-weight:700;width:18px;height:18px;border-radius:50%;align-items:center;justify-content:center;font-family:Inter,sans-serif}

    /* Online badge */
    .kyu-online-badge{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9999;font-size:.72rem;font-family:Inter,sans-serif;padding:.22rem .7rem;border-radius:50px;font-weight:600;color:#F4A300;background:#0B3B2F;border:1px solid #F4A300;pointer-events:none;transition:.5s}

    /* Buttons */
    .kyu-btn-danger{background:#dc3545;color:#fff;border:none;padding:.7rem 1.5rem;border-radius:50px;font-weight:600;cursor:pointer;width:100%;font-family:Inter,sans-serif;transition:.25s;font-size:1rem}
    .kyu-btn-danger:hover{background:#c82333;transform:scale(1.02)}
    .kyu-delete-btn{background:none;border:none;color:#ccc;cursor:pointer;font-size:1rem;transition:.2s;padding:.2rem .4rem;border-radius:6px}
    .kyu-delete-btn:hover{color:#dc3545;background:#fff5f5}

    /* Cards */
    .kyu-card-anim{animation:kyu-fade-in .4s ease both}
    .kyu-img-preview{width:100%;max-height:200px;object-fit:cover;border-radius:8px;margin-top:.8rem;display:none;border:2px solid #F4A300}
    .kyu-img-modal{position:fixed;inset:0;background:rgba(0,0,0,.88);z-index:99999;display:flex;align-items:center;justify-content:center;cursor:zoom-out}
    .kyu-img-modal img{max-width:90vw;max-height:90vh;border-radius:12px;box-shadow:0 0 60px rgba(0,0,0,.5)}
    .kyu-info-row{display:flex;align-items:flex-start;gap:.75rem;margin-bottom:.75rem;font-family:Inter,sans-serif}
    .kyu-info-row i{color:#F4A300;width:20px;flex-shrink:0;margin-top:.15rem}
    .kyu-info-row span{color:#555;font-size:.93rem}

    /* Status badges */
    .status-claimed  {background:#28a745;color:#fff;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:50px}
    .status-pending  {background:#F4A300;color:#0B3B2F;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:50px}
    .status-resolved {background:#6c757d;color:#fff;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:50px}
    .status-sold     {background:#6c757d;color:#fff;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:50px}
    .status-available{background:#0B3B2F;color:#F4A300;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:50px}

    /* Filter chips */
    .filter-chip{background:#fff;border:2px solid #e9ecef;color:#555;padding:.33rem .85rem;border-radius:50px;cursor:pointer;font-family:Inter,sans-serif;font-size:.83rem;font-weight:500;transition:.2s}
    .filter-chip:hover,.filter-chip.active{background:#0B3B2F;border-color:#0B3B2F;color:#fff}

    /* Marketplace extras */
    .img-wrap{position:relative;overflow:hidden}
    .wishlist-btn{position:absolute;top:8px;right:8px;background:rgba(255,255,255,.9);border:none;width:34px;height:34px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.25s;color:#ccc;font-size:1rem;box-shadow:0 2px 8px rgba(0,0,0,.15)}
    .wishlist-btn:hover,.wishlist-btn.active{color:#dc3545}
    .views-badge{position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,.5);color:#fff;font-size:.7rem;padding:.18rem .5rem;border-radius:50px;font-family:Inter,sans-serif}

    /* Auth pages */
    .kyu-strength{height:4px;border-radius:4px;margin-top:.4rem;transition:.4s;background:#eee}
    .field-err{color:#dc3545;font-size:.82rem;margin-top:.3rem;display:none}
    .login-err,.signup-err{color:#dc3545;font-size:.88rem;background:#fff5f5;border:1px solid #f5c6cb;border-radius:8px;padding:.6rem 1rem;margin-bottom:.5rem;display:none;font-family:Inter,sans-serif}

    /* Auth card styles */
    .kyu-auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0B3B2F 0%,#1a5c47 60%,#F4A300 100%);padding:1.5rem}
    .kyu-auth-card{background:#fff;border-radius:20px;width:100%;max-width:440px;box-shadow:0 24px 64px rgba(0,0,0,.3);overflow:hidden}
    .kyu-auth-head{background:#0B3B2F;padding:2rem;text-align:center;color:#fff}
    .kyu-auth-head h1{font-size:1.7rem;font-weight:800;margin:.8rem 0 .4rem;font-family:Inter,sans-serif}
    .kyu-auth-head p{color:rgba(255,255,255,.7);font-size:.93rem;margin:0;font-family:Inter,sans-serif}
    .kyu-auth-logo-wrap{width:60px;height:60px;background:#F4A300;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto;font-size:1.6rem;color:#0B3B2F}
    .kyu-auth-body{padding:2rem}
    .kyu-field{margin-bottom:1.4rem}
    .kyu-field label{font-weight:600;display:block;margin-bottom:.45rem;color:#0B3B2F;font-size:.9rem;font-family:Inter,sans-serif}
    .kyu-field input{width:100%;padding:.78rem 1rem;border:2px solid #e9ecef;border-radius:10px;font-family:Inter,sans-serif;font-size:.97rem;transition:.25s;outline:none}
    .kyu-field input:focus{border-color:#F4A300;box-shadow:0 0 0 3px rgba(244,163,0,.15)}
    .kyu-input-wrap{position:relative}
    .kyu-input-wrap input{padding-right:3rem}
    .toggle-pw{position:absolute;right:.8rem;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#aaa;padding:.2rem;font-size:1rem;transition:.2s}
    .toggle-pw:hover{color:#0B3B2F}
    .kyu-btn-primary{width:100%;padding:.9rem;background:linear-gradient(135deg,#F4A300,#e09100);color:#0B3B2F;border:none;border-radius:12px;font-size:1rem;font-weight:700;cursor:pointer;font-family:Inter,sans-serif;transition:.25s;margin-top:.5rem}
    .kyu-btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(244,163,0,.4)}
    .kyu-btn-primary:disabled{opacity:.6;cursor:not-allowed;transform:none}
    .kyu-auth-footer{text-align:center;margin-top:1.2rem;color:#888;font-size:.88rem;font-family:Inter,sans-serif}
    .kyu-auth-footer a{color:#0B3B2F;font-weight:600;text-decoration:none}
    .kyu-auth-footer a:hover{color:#F4A300}
    .kyu-terms{display:flex;align-items:flex-start;gap:.6rem;font-size:.85rem;color:#555;font-family:Inter,sans-serif;cursor:pointer;margin-bottom:.5rem}
    .kyu-terms input{margin-top:.15rem;accent-color:#0B3B2F}

    /* Responsive */
    @media(max-width:480px){
      .kyu-modal-body{padding:1.2rem}
      .kyu-modal-foot{padding:0 1.2rem 1.2rem}
      .kyu-auth-body{padding:1.4rem}
    }
  `;
  document.head.appendChild(css);

  return {
    auth,
    storage,
    ui,
    resizeImage,
    uploadImage,
    svgPlaceholder,
    isOnline,
  };
})();
