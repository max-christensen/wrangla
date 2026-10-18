// Wrangla API worker.
// Routes under /api/* are handled here. Everything else falls through to
// the static frontend in /public via the ASSETS binding (see wrangler.toml).

const COOKIE_NAME = "session";
const SESSION_HOURS = 24 * 30; // a session lasts 30 days, so the emailed code repeats roughly monthly
const CODE_MINUTES = 10;       // how long an emailed login code is valid
const CODE_MAX_ATTEMPTS = 5;   // wrong guesses allowed per code
const CODE_MAX_PER_WINDOW = 5; // codes that can be requested per user per CODE_MINUTES

// ---------- small helpers ----------

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- password hashing (PBKDF2 via Web Crypto, no dependencies) ----------

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256
  );
  return `${iterations}:${b64url(salt)}:${b64url(bits)}`;
}

async function verifyPassword(password, stored) {
  const [iterStr, saltB64, hashB64] = stored.split(":");
  const iterations = parseInt(iterStr, 10);
  const salt = b64urlToBytes(saltB64);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256
  );
  return b64url(bits) === hashB64;
}

// ---------- signed session cookie (HMAC-SHA256) ----------

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

async function makeSession(payload, secret) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

async function readSession(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC", key, b64urlToBytes(sig), new TextEncoder().encode(body)
  );
  if (!valid) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookieHeader(name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join("; ");
}

// The key that signs sessions and login codes. If the SESSION_SECRET secret is set it is used exactly as
// before. If not (for example after a one-click button install), a random key is generated on first use and
// kept in the settings table, so an install needs no secrets typed in. It is never returned by any endpoint.
let generatedSecret = null;
async function sessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (generatedSecret) return generatedSecret;
  let row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'session_secret'").first();
  if (!row) {
    const fresh = b64url(crypto.getRandomValues(new Uint8Array(32)));
    // INSERT OR IGNORE so two first requests at once agree on one key.
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('session_secret', ?)").bind(fresh).run();
    row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'session_secret'").first();
  }
  generatedSecret = row.value;
  return generatedSecret;
}

async function getUser(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  const payload = await readSession(token, await sessionSecret(env));
  if (!payload || payload.kind) return null; // "kind" marks a half-finished 2FA login, not a session
  const user = await env.DB.prepare(
    "SELECT id, name, email, role, color, active FROM users WHERE id = ? AND active = 1"
  ).bind(payload.uid).first();
  return user || null;
}

// ---------- multi-day items ----------

const MAX_ITEM_DAYS = 60;

function addDaysIso(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isWeekendIso(iso) {
  const dow = new Date(iso + "T00:00:00Z").getUTCDay();
  return dow === 0 || dow === 6;
}

// The calendar days an item occupies. One-day items stay exactly where they were put.
// A multi-day item with "skip weekends" on starts on the first weekday on or after its start date
// and steps over Saturdays and Sundays, so Thursday + 3 days = Thu, Fri, Mon.
function itemDates(start, days, skipWeekends) {
  const n = Math.max(1, Math.min(MAX_ITEM_DAYS, parseInt(days, 10) || 1));
  if (!start) return [];
  if (n === 1) return [start];
  const out = [];
  let d = start;
  if (skipWeekends) while (isWeekendIso(d)) d = addDaysIso(d, 1);
  while (out.length < n) {
    if (!skipWeekends || !isWeekendIso(d)) out.push(d);
    d = addDaysIso(d, 1);
  }
  return out;
}

function minutesBetween(start, end) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm));
}

// ---------- route handlers ----------

async function handleSetup(request, env) {
  const body = await request.json();
  const { setup_key, name, email, password } = body;
  // With a SETUP_KEY secret set, the key is required exactly as before. Without one, setup is open
  // until the first admin exists (it always closes itself after that).
  if (env.SETUP_KEY && (!setup_key || setup_key !== env.SETUP_KEY)) {
    return json({ error: "Invalid setup key" }, 403);
  }
  const existingAdmin = await env.DB.prepare(
    "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
  ).first();
  if (existingAdmin) {
    return json({ error: "Admin already exists. Setup is one-time only." }, 403);
  }
  if (!name || !email || !password || password.length < 8) {
    return json({ error: "Name, email, and an 8+ character password are required" }, 400);
  }
  const hash = await hashPassword(password);
  // Insert only if there is still no admin at this instant, so two setup requests at once can't make two.
  const result = await env.DB.prepare(
    `INSERT INTO users (name, email, password_hash, role, color)
     SELECT ?, ?, ?, 'admin', '#1F2A24' WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`
  ).bind(name, email.toLowerCase(), hash).run();
  if (!result.meta.changes) return json({ error: "Admin already exists. Setup is one-time only." }, 403);
  return json({ ok: true });
}

// ---------- two-factor login: password, then a six digit code emailed via Resend ----------
// 2FA is on whenever the RESEND_API_KEY secret is set (unless an admin switches it off in Settings).
// Without the key, password login alone creates the session so an install without email still works.

function twoFactorOn(env, settings) {
  return !!env.RESEND_API_KEY && settings.twofa_enabled !== "0";
}

async function hashCode(env, userId, code) {
  const key = await hmacKey(await sessionSecret(env));
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`login-code:${userId}:${code}`)));
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, "0");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

async function sendLoginCode(env, toEmail, code, company) {
  // RESEND_API_URL only exists so the flow can be tested against a local stand-in.
  const res = await fetch(env.RESEND_API_URL || "https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.MAIL_FROM || "Wrangla <onboarding@resend.dev>",
      to: [toEmail],
      subject: `Your ${company} login code: ${code}`,
      text: `Your ${company} login code is ${code}. It is valid for ${CODE_MINUTES} minutes. If you did not try to log in, you can ignore this email.`,
      html: `<p>Your <strong>${escapeHtml(company)}</strong> login code is:</p>` +
            `<p style="font-size:28px; letter-spacing:6px; font-weight:bold;">${code}</p>` +
            `<p>It is valid for ${CODE_MINUTES} minutes. If you did not try to log in, you can ignore this email.</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}`);
}

function startSession(user, env) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  return sessionSecret(env).then(secret => makeSession({ uid: user.id, exp }, secret)).then(token => json(
    { id: user.id, name: user.name, email: user.email, role: user.role, color: user.color },
    200,
    { "Set-Cookie": setCookieHeader(COOKIE_NAME, token, SESSION_HOURS * 3600) }
  ));
}

async function handleLogin(request, env) {
  const { email, password } = await request.json();
  if (!email || !password) return json({ error: "Email and password required" }, 400);
  const user = await env.DB.prepare(
    "SELECT * FROM users WHERE email = ? AND active = 1"
  ).bind(email.toLowerCase()).first();
  if (!user) return json({ error: "Invalid email or password" }, 401);
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return json({ error: "Invalid email or password" }, 401);

  const settings = await loadSettings(env);
  // The optional demo account (a viewer named in DEMO_LOGIN_EMAIL) signs in with just its password.
  const isDemo = user.role === "viewer" && !!env.DEMO_LOGIN_EMAIL && user.email === env.DEMO_LOGIN_EMAIL.toLowerCase();
  if (isDemo || !twoFactorOn(env, settings)) return startSession(user, env);

  // Password was right: email a code. No session exists until the code is confirmed.
  await env.DB.prepare("DELETE FROM login_codes WHERE expires_at < ?").bind(new Date().toISOString()).run();
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ? AND created_at > ?"
  ).bind(user.id, new Date(Date.now() - CODE_MINUTES * 60000).toISOString()).first();
  if (recent.n >= CODE_MAX_PER_WINDOW) {
    return json({ error: "Too many codes requested. Wait a few minutes and try again." }, 429);
  }
  const code = randomCode();
  const created = new Date();
  const inserted = await env.DB.prepare(
    "INSERT INTO login_codes (user_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(user.id, await hashCode(env, user.id, code), new Date(created.getTime() + CODE_MINUTES * 60000).toISOString(), created.toISOString()).run();
  try {
    await sendLoginCode(env, user.email, code, settings.company_name || "Wrangla");
  } catch (e) {
    await env.DB.prepare("DELETE FROM login_codes WHERE id = ?").bind(inserted.meta.last_row_id).run();
    return json({ error: "Could not send the login code email. Ask your administrator to check the Resend setup." }, 502);
  }
  const challenge = await makeSession(
    { uid: user.id, kind: "2fa", exp: Date.now() + CODE_MINUTES * 60000 }, await sessionSecret(env)
  );
  const [local, domain] = user.email.split("@");
  return json({ needs_code: true, challenge, sent_to: `${local.slice(0, 2)}***@${domain}` });
}

async function handleVerifyCode(request, env) {
  const { challenge, code } = await request.json();
  const payload = await readSession(challenge, await sessionSecret(env));
  if (!payload || payload.kind !== "2fa") return json({ error: "That login attempt has expired. Please log in again." }, 401);
  const row = await env.DB.prepare(
    "SELECT * FROM login_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1"
  ).bind(payload.uid).first();
  if (!row || row.expires_at < new Date().toISOString()) {
    return json({ error: "That code has expired. Please log in again to get a new one." }, 401);
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await env.DB.prepare("DELETE FROM login_codes WHERE user_id = ?").bind(payload.uid).run();
    return json({ error: "Too many wrong codes. Please log in again to get a new one." }, 429);
  }
  const given = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(given) || !sameString(await hashCode(env, payload.uid, given), row.code_hash)) {
    await env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
    return json({ error: "That code isn't right." }, 401);
  }
  await env.DB.prepare("DELETE FROM login_codes WHERE user_id = ?").bind(payload.uid).run();
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ? AND active = 1").bind(payload.uid).first();
  if (!user) return json({ error: "Account not available" }, 401);
  return startSession(user, env);
}

function handleLogout() {
  return json({ ok: true }, 200, { "Set-Cookie": setCookieHeader(COOKIE_NAME, "", 0) });
}

// ---- company settings & branding ----

const COMPANY_FIELDS = ["company_name", "company_address", "company_phone", "company_email", "company_reg"];
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAIN = "#1F2A24";
const DEFAULT_ACCENT = "#3B6E71";

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

async function loadSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const out = {};
  for (const r of results) out[r.key] = r.value;
  return out;
}

async function saveSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

// What the login screen (and everyone else) may see before logging in.
async function handlePublicSettings(env) {
  const s = await loadSettings(env);
  const admin = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").first();
  return json({
    company_name: s.company_name || "",
    has_logo: !!s.logo_key,
    logo_version: s.logo_version || "",
    main_color: s.main_color || DEFAULT_MAIN,
    accent_color: s.accent_color || DEFAULT_ACCENT,
    needs_setup: !admin,
    setup_key_required: !!env.SETUP_KEY,
    ...(env.DEMO_LOGIN_EMAIL ? { demo_login_email: env.DEMO_LOGIN_EMAIL.toLowerCase() } : {}),
  });
}

async function handleGetSettings(env) {
  const s = await loadSettings(env);
  const out = {
    has_logo: !!s.logo_key, logo_version: s.logo_version || "", setup_complete: s.setup_complete === "1",
    main_color: s.main_color || DEFAULT_MAIN, accent_color: s.accent_color || DEFAULT_ACCENT,
    twofa_enabled: s.twofa_enabled !== "0", resend_configured: !!env.RESEND_API_KEY,
    skip_weekends: s.skip_weekends === "1",
  };
  for (const k of COMPANY_FIELDS) out[k] = s[k] || "";
  return json(out);
}

async function handleUpdateSettings(request, env) {
  const b = await request.json();
  for (const k of ["main_color", "accent_color"]) {
    if (b[k] !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(b[k])) return json({ error: "Colours must look like #1F2A24" }, 400);
    }
  }
  // The accent colour is used for links and the logo mark on white, so it has to be readable there.
  if (b.accent_color !== undefined && contrastRatio(b.accent_color, "#FFFFFF") < 4.5) {
    return json({ error: "That accent colour is too light to read on white. Pick a darker one." }, 400);
  }
  for (const k of COMPANY_FIELDS) {
    if (b[k] !== undefined) await saveSetting(env, k, String(b[k]).trim().slice(0, 300));
  }
  for (const k of ["main_color", "accent_color"]) {
    if (b[k] !== undefined) await saveSetting(env, k, b[k].toUpperCase());
  }
  if (b.skip_weekends !== undefined) await saveSetting(env, "skip_weekends", b.skip_weekends ? "1" : "0");
  if (b.twofa_enabled !== undefined) await saveSetting(env, "twofa_enabled", b.twofa_enabled ? "1" : "0");
  if (b.setup_complete) await saveSetting(env, "setup_complete", "1");
  return json({ ok: true });
}

async function handleUploadLogo(request, env) {
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "No file received" }, 400);
  if (!LOGO_TYPES.includes(file.type)) return json({ error: "Logo must be a PNG, JPG, WebP, GIF or SVG image" }, 400);
  if (file.size > LOGO_MAX_BYTES) return json({ error: "Logo is too large (2MB max)" }, 400);
  await env.ATTACHMENTS.put("branding/logo", await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  await saveSetting(env, "logo_key", "branding/logo");
  await saveSetting(env, "logo_type", file.type);
  await saveSetting(env, "logo_version", String(Date.now()));
  return json({ ok: true });
}

async function handleDeleteLogo(env) {
  await env.ATTACHMENTS.delete("branding/logo");
  await env.DB.prepare("DELETE FROM settings WHERE key IN ('logo_key', 'logo_type', 'logo_version')").run();
  return json({ ok: true });
}

async function handleGetLogo(env) {
  const s = await loadSettings(env);
  if (!s.logo_key) return json({ error: "No logo" }, 404);
  const object = await env.ATTACHMENTS.get(s.logo_key);
  if (!object) return json({ error: "No logo" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": s.logo_type || "image/png",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      // An SVG opened directly can't run scripts.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

// ---- users (admin only, except GET which any logged-in user can use to see names/colors) ----

async function handleListUsers(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, email, role, color, active FROM users ORDER BY name"
  ).all();
  return json(results);
}

// users.role is free text; these are the three roles the app knows about.
function cleanRole(role) { return role === "admin" || role === "viewer" ? role : "worker"; }

async function handleCreateUser(request, env) {
  const { name, email, password, role, color } = await request.json();
  if (!name || !email || !password || password.length < 8) {
    return json({ error: "Name, email, and an 8+ character password are required" }, 400);
  }
  const hash = await hashPassword(password);
  try {
    const result = await env.DB.prepare(
      "INSERT INTO users (name, email, password_hash, role, color) VALUES (?, ?, ?, ?, ?)"
    ).bind(name, email.toLowerCase(), hash, cleanRole(role), color || "#3B6E71").run();
    return json({ id: result.meta.last_row_id });
  } catch (e) {
    return json({ error: "That email is already in use" }, 400);
  }
}

async function handleUpdateUser(request, env, id) {
  const body = await request.json();
  const fields = [];
  const values = [];
  if (body.name !== undefined) { fields.push("name = ?"); values.push(body.name); }
  if (body.email !== undefined) { fields.push("email = ?"); values.push(body.email.toLowerCase()); }
  if (body.role !== undefined) { fields.push("role = ?"); values.push(cleanRole(body.role)); }
  if (body.color !== undefined) { fields.push("color = ?"); values.push(body.color); }
  if (body.active !== undefined) { fields.push("active = ?"); values.push(body.active ? 1 : 0); }
  if (body.password) {
    if (body.password.length < 8) return json({ error: "Password must be 8+ characters" }, 400);
    fields.push("password_hash = ?");
    values.push(await hashPassword(body.password));
  }
  if (!fields.length) return json({ error: "Nothing to update" }, 400);
  values.push(id);
  await env.DB.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  return json({ ok: true });
}

// ---- clients ----

async function handleListClients(env) {
  const { results } = await env.DB.prepare("SELECT * FROM clients ORDER BY name").all();
  return json(results);
}

async function handleCreateClient(request, env) {
  const { name, nickname, address, contact_name, phone, email, notes } = await request.json();
  if (!name) return json({ error: "Client name is required" }, 400);
  const result = await env.DB.prepare(
    "INSERT INTO clients (name, nickname, address, contact_name, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(name, nickname || null, address || null, contact_name || null, phone || null, email || null, notes || null).run();
  return json({ id: result.meta.last_row_id });
}

async function handleUpdateClient(request, env, id) {
  const { name, nickname, address, contact_name, phone, email, notes } = await request.json();
  await env.DB.prepare(
    "UPDATE clients SET name = ?, nickname = ?, address = ?, contact_name = ?, phone = ?, email = ?, notes = ? WHERE id = ?"
  ).bind(name, nickname || null, address || null, contact_name || null, phone || null, email || null, notes || null, id).run();
  return json({ ok: true });
}

async function handleDeleteClient(env, id) {
  await env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ---- project sites (belong to a client) ----

async function handleListSites(request, env) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  let sql = "SELECT * FROM project_sites";
  const params = [];
  if (clientId) { sql += " WHERE client_id = ?"; params.push(clientId); }
  sql += " ORDER BY name";
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json(results);
}

async function handleCreateSite(request, env) {
  const { client_id, name, address, contact_name, phone, notes } = await request.json();
  if (!client_id || !name || !address) return json({ error: "Client, site name, and address are required" }, 400);
  const result = await env.DB.prepare(
    "INSERT INTO project_sites (client_id, name, address, contact_name, phone, notes) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(client_id, name, address, contact_name || null, phone || null, notes || null).run();
  return json({ id: result.meta.last_row_id });
}

async function handleUpdateSite(request, env, id) {
  const { name, address, contact_name, phone, notes } = await request.json();
  await env.DB.prepare(
    "UPDATE project_sites SET name = ?, address = ?, contact_name = ?, phone = ?, notes = ? WHERE id = ?"
  ).bind(name, address, contact_name || null, phone || null, notes || null, id).run();
  return json({ ok: true });
}

async function handleDeleteSite(env, id) {
  await env.DB.prepare("DELETE FROM project_sites WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ---- job type suggestions (free text, but we remember what's been typed before) ----

async function handleListJobTypes(env) {
  const { results } = await env.DB.prepare(
    "SELECT job_type, COUNT(*) AS uses FROM appointments WHERE job_type IS NOT NULL AND job_type != '' GROUP BY job_type ORDER BY uses DESC, job_type"
  ).all();
  return json(results.map(r => r.job_type));
}

// ---- job comments (running notes thread, everyone can see and post) ----

async function handleListComments(env, appointmentId) {
  const { results } = await env.DB.prepare(`
    SELECT jc.id, jc.comment, jc.created_at, u.name AS user_name, u.color AS user_color
    FROM job_comments jc JOIN users u ON u.id = jc.user_id
    WHERE jc.appointment_id = ? ORDER BY jc.created_at ASC
  `).bind(appointmentId).all();
  return json(results);
}

async function handleAddComment(request, env, user, appointmentId) {
  const { comment } = await request.json();
  if (!comment || !comment.trim()) return json({ error: "Comment can't be empty" }, 400);
  const result = await env.DB.prepare(
    "INSERT INTO job_comments (appointment_id, user_id, comment) VALUES (?, ?, ?)"
  ).bind(appointmentId, user.id, comment.trim()).run();
  return json({ id: result.meta.last_row_id });
}

// ---- job attachments (photos, PDFs — metadata in D1, bytes in R2) ----

async function handleListAttachments(env, appointmentId) {
  const { results } = await env.DB.prepare(`
    SELECT ja.id, ja.filename, ja.content_type, ja.size_bytes, ja.uploaded_at, u.name AS uploaded_by_name
    FROM job_attachments ja JOIN users u ON u.id = ja.uploaded_by
    WHERE ja.appointment_id = ? ORDER BY ja.uploaded_at DESC
  `).bind(appointmentId).all();
  return json(results);
}

async function handleUploadAttachment(request, env, user, appointmentId) {
  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "No file received" }, 400);
  if (file.size > 20 * 1024 * 1024) return json({ error: "File is too large (20MB max)" }, 400);

  const r2Key = `job-${appointmentId}/${crypto.randomUUID()}-${file.name}`;
  await env.ATTACHMENTS.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
  const result = await env.DB.prepare(`
    INSERT INTO job_attachments (appointment_id, filename, r2_key, content_type, size_bytes, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(appointmentId, file.name, r2Key, file.type || null, file.size, user.id).run();
  return json({ id: result.meta.last_row_id });
}

async function handleDeleteAttachment(env, id) {
  const row = await env.DB.prepare("SELECT r2_key FROM job_attachments WHERE id = ?").bind(id).first();
  if (row) await env.ATTACHMENTS.delete(row.r2_key);
  await env.DB.prepare("DELETE FROM job_attachments WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function handleGetAttachmentFile(env, id) {
  const row = await env.DB.prepare("SELECT * FROM job_attachments WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "Not found" }, 404);
  const object = await env.ATTACHMENTS.get(row.r2_key);
  if (!object) return json({ error: "File missing from storage" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": row.content_type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${row.filename.replace(/"/g, "")}"`,
    },
  });
}

// ---- appointments / tasks ----

async function handleListAppointments(request, env, user) {
  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const assignedTo = url.searchParams.get("assigned_to");
  const skipWeekends = (await loadSettings(env)).skip_weekends === "1";
  const startExpr = "COALESCE(a.scheduled_date, a.due_date)";

  let sql = `
    SELECT a.*, c.name AS client_name, c.nickname AS client_nickname, c.address AS client_address,
           s.name AS site_name, s.address AS site_full_address, s.contact_name AS site_contact_name, s.phone AS site_phone
    FROM appointments a
    LEFT JOIN clients c ON c.id = a.client_id
    LEFT JOIN project_sites s ON s.id = a.site_id
    WHERE ${startExpr} IS NOT NULL
  `;
  const params = [];

  if (user.role !== "admin" && user.role !== "viewer") {
    // workers see their own items plus unassigned ones (admins and viewers see everything)
    sql += ` AND (EXISTS (SELECT 1 FROM item_people ip WHERE ip.appointment_id = a.id AND ip.user_id = ?)
              OR NOT EXISTS (SELECT 1 FROM item_people ip WHERE ip.appointment_id = a.id))`;
    params.push(user.id);
  } else if (assignedTo) {
    sql += " AND EXISTS (SELECT 1 FROM item_people ip WHERE ip.appointment_id = a.id AND ip.user_id = ?)";
    params.push(assignedTo);
  }

  // Coarse SQL filter (a multi-day item can start before the range and run into it); exact check below.
  if (start && end) {
    sql += ` AND ((${startExpr} <= ? AND date(${startExpr}, '+' || (a.days * 2 + 3) || ' days') >= ?)
              OR EXISTS (SELECT 1 FROM time_entries te WHERE te.appointment_id = a.id AND te.work_date BETWEEN ? AND ?))`;
    params.push(end, start, start, end);
  }
  sql += ` ORDER BY ${startExpr}, a.id`;

  const { results } = await env.DB.prepare(sql).bind(...params).all();

  let entries = [];
  if (results.length) {
    const entrySql = `SELECT te.*, u.name AS user_name FROM time_entries te JOIN users u ON u.id = te.user_id` +
      (start && end ? " WHERE te.work_date BETWEEN ? AND ?" : "") + " ORDER BY te.work_date";
    entries = (await env.DB.prepare(entrySql).bind(...(start && end ? [start, end] : [])).all()).results;
  }
  const entriesByItem = {};
  for (const e of entries) (entriesByItem[e.appointment_id] ||= []).push(e);
  const peopleByItem = {};
  if (results.length) {
    const { results: ppl } = await env.DB.prepare(
      "SELECT ip.appointment_id, u.id, u.name, u.color FROM item_people ip JOIN users u ON u.id = ip.user_id ORDER BY ip.rowid"
    ).all();
    for (const r of ppl) (peopleByItem[r.appointment_id] ||= []).push({ id: r.id, name: r.name, color: r.color });
  }

  const items = [];
  for (const a of results) {
    a.dates = itemDates(a.scheduled_date || a.due_date, a.days, skipWeekends);
    a.entries = entriesByItem[a.id] || [];
    // `people` is the full list; assigned_* describe the first person, which is all the screens use today.
    a.people = peopleByItem[a.id] || [];
    a.assigned_to = a.people.length ? a.people[0].id : null;
    a.assigned_name = a.people.length ? a.people[0].name : null;
    a.assigned_color = a.people.length ? a.people[0].color : null;
    if (start && end && !a.dates.some(d => d >= start && d <= end) && !a.entries.length) continue;
    items.push(a);
  }
  return json(items);
}

// ---- people on an item: one row per person in item_people (the form picks one for now) ----

function parsePeople(b, user) {
  if (user.role !== "admin") return [user.id];
  const raw = Array.isArray(b.people) ? b.people : (b.assigned_to ? [b.assigned_to] : []);
  return [...new Set(raw.map(v => parseInt(v, 10)).filter(Number.isInteger))];
}

async function getPeopleIds(env, itemId) {
  const { results } = await env.DB.prepare(
    "SELECT user_id FROM item_people WHERE appointment_id = ? ORDER BY rowid"
  ).bind(itemId).all();
  return results.map(r => r.user_id);
}

function setPeopleStatements(env, itemId, ids) {
  return [
    env.DB.prepare("DELETE FROM item_people WHERE appointment_id = ?").bind(itemId),
    ...ids.map(uid => env.DB.prepare("INSERT INTO item_people (appointment_id, user_id) VALUES (?, ?)").bind(itemId, uid)),
  ];
}

function clampDays(v) {
  return Math.max(1, Math.min(MAX_ITEM_DAYS, parseInt(v, 10) || 1));
}

async function handleCreateAppointment(request, env, user) {
  const b = await request.json();
  if (!b.title) return json({ error: "Title is required" }, 400);

  const result = await env.DB.prepare(`
    INSERT INTO appointments
      (title, client_id, site_id, created_by, activity_type, job_type, location_type,
       site_address, scheduled_date, due_date, notes, estimate_minutes, days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    b.title,
    b.client_id || null,
    b.site_id || null,
    user.id,
    b.activity_type === "task" ? "task" : "appointment",
    b.job_type || null,
    b.location_type === "project_site" ? "project_site" : "head_office",
    b.site_address || null,
    b.scheduled_date || null,
    b.due_date || null,
    b.notes || null,
    b.estimate_minutes || null,
    clampDays(b.days)
  ).run();

  const id = result.meta.last_row_id;
  const people = parsePeople(b, user);
  if (people.length) await env.DB.batch(setPeopleStatements(env, id, people));
  return json({ id });
}

// ---- recurring series: generate N standalone appointment/task rows up front ----

function generateRecurrenceDates(startDate, frequency, monthlyMode, count) {
  const dates = [];
  const start = new Date(startDate + "T00:00:00Z");
  if (frequency === "weekly" || frequency === "fortnightly") {
    const step = frequency === "weekly" ? 7 : 14;
    for (let i = 0; i < count; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i * step);
      dates.push(d.toISOString().slice(0, 10));
    }
  } else if (frequency === "monthly") {
    if (monthlyMode === "weekday") {
      const weekday = start.getUTCDay();
      const ordinal = Math.floor((start.getUTCDate() - 1) / 7) + 1; // which "Nth weekday" in its month
      for (let i = 0; i < count; i++) {
        const targetMonth = start.getUTCMonth() + i;
        const targetYear = start.getUTCFullYear() + Math.floor(targetMonth / 12);
        const monthIndex = ((targetMonth % 12) + 12) % 12;
        const first = new Date(Date.UTC(targetYear, monthIndex, 1));
        const firstWeekday = first.getUTCDay();
        let dayOfMonth = 1 + ((weekday - firstWeekday + 7) % 7) + (ordinal - 1) * 7;
        const daysInMonth = new Date(Date.UTC(targetYear, monthIndex + 1, 0)).getUTCDate();
        if (dayOfMonth > daysInMonth) dayOfMonth -= 7; // fall back a week if the 5th doesn't exist that month
        dates.push(new Date(Date.UTC(targetYear, monthIndex, dayOfMonth)).toISOString().slice(0, 10));
      }
    } else {
      const day = start.getUTCDate();
      for (let i = 0; i < count; i++) {
        const targetMonth = start.getUTCMonth() + i;
        const targetYear = start.getUTCFullYear() + Math.floor(targetMonth / 12);
        const monthIndex = ((targetMonth % 12) + 12) % 12;
        const daysInMonth = new Date(Date.UTC(targetYear, monthIndex + 1, 0)).getUTCDate();
        const clampedDay = Math.min(day, daysInMonth);
        dates.push(new Date(Date.UTC(targetYear, monthIndex, clampedDay)).toISOString().slice(0, 10));
      }
    }
  }
  return dates;
}

async function handleCreateRecurring(request, env, user) {
  const b = await request.json();
  if (!b.title) return json({ error: "Title is required" }, 400);
  if (!b.start_date) return json({ error: "A start date is required" }, 400);
  if (!["weekly", "fortnightly", "monthly"].includes(b.frequency)) {
    return json({ error: "Pick a valid frequency" }, 400);
  }
  const count = Math.min(52, Math.max(1, parseInt(b.occurrences, 10) || 12));
  const dates = generateRecurrenceDates(b.start_date, b.frequency, b.monthly_mode, count);
  const seriesId = crypto.randomUUID();
  const people = parsePeople(b, user);
  const isTask = b.activity_type === "task";

  const stmt = env.DB.prepare(`
    INSERT INTO appointments
      (title, client_id, site_id, created_by, activity_type, job_type, location_type,
       site_address, scheduled_date, due_date, notes, series_id, estimate_minutes, days)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const batch = dates.map(dateStr => stmt.bind(
    b.title,
    b.client_id || null,
    b.site_id || null,
    user.id,
    isTask ? "task" : "appointment",
    b.job_type || null,
    b.location_type === "project_site" ? "project_site" : "head_office",
    b.site_address || null,
    isTask ? null : dateStr,
    isTask ? dateStr : null,
    b.notes || null,
    seriesId,
    b.estimate_minutes || null,
    clampDays(b.days)
  ));
  const peopleStmts = people.map(uid => env.DB.prepare(
    "INSERT INTO item_people (appointment_id, user_id) SELECT id, ? FROM appointments WHERE series_id = ?"
  ).bind(uid, seriesId));
  await env.DB.batch([...batch, ...peopleStmts]);
  return json({ ok: true, count: dates.length, series_id: seriesId });
}

async function handleDeleteSeries(env, seriesId) {
  await env.DB.prepare(
    "DELETE FROM appointments WHERE series_id = ? AND status != 'completed'"
  ).bind(seriesId).run();
  return json({ ok: true });
}

async function handleUpdateAppointment(request, env, user, id) {
  const existing = await env.DB.prepare("SELECT * FROM appointments WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);
  const peopleIds = await getPeopleIds(env, id);
  if (user.role !== "admin" && !peopleIds.includes(user.id)) {
    return json({ error: "Not your appointment" }, 403);
  }

  const b = await request.json();
  const fields = [];
  const values = [];

  // Admin can edit everything, including reassigning/rescheduling.
  if (user.role === "admin") {
    const editable = {
      title: b.title, client_id: b.client_id, site_id: b.site_id,
      activity_type: b.activity_type, job_type: b.job_type, location_type: b.location_type,
      site_address: b.site_address, scheduled_date: b.scheduled_date,
      due_date: b.due_date, notes: b.notes, status: b.status, estimate_minutes: b.estimate_minutes,
      days: b.days !== undefined ? clampDays(b.days) : undefined,
    };
    for (const [k, v] of Object.entries(editable)) {
      if (v !== undefined) { fields.push(`${k} = ?`); values.push(v); }
    }
  } else {
    // Workers can only add notes / log their hours / mark complete.
    if (b.notes !== undefined) { fields.push("notes = ?"); values.push(b.notes); }
  }

  // Anyone assigned can mark their own item complete (hours are logged per day, see handleSaveTime).
  if (b.mark_complete) {
    fields.push("status = ?"); values.push("completed");
    fields.push("completed_at = ?"); values.push(new Date().toISOString());
  }

  const changePeople = user.role === "admin" && (b.people !== undefined || b.assigned_to !== undefined);
  if (!fields.length && !changePeople) return json({ error: "Nothing to update" }, 400);
  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);

  const stmts = [env.DB.prepare(`UPDATE appointments SET ${fields.join(", ")} WHERE id = ?`).bind(...values)];
  if (changePeople) stmts.push(...setPeopleStatements(env, id, parsePeople(b, user)));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

// ---- time entries: one row per person per day, per item ----

async function handleListTime(env, id) {
  const { results } = await env.DB.prepare(`
    SELECT te.*, u.name AS user_name FROM time_entries te JOIN users u ON u.id = te.user_id
    WHERE te.appointment_id = ? ORDER BY te.work_date, te.id
  `).bind(id).all();
  return json(results);
}

async function handleSaveTime(request, env, user, id) {
  const item = await env.DB.prepare("SELECT * FROM appointments WHERE id = ?").bind(id).first();
  if (!item) return json({ error: "Not found" }, 404);
  const peopleIds = await getPeopleIds(env, id);
  if (user.role !== "admin" && !peopleIds.includes(user.id)) return json({ error: "Not your appointment" }, 403);

  const { entries } = await request.json();
  if (!Array.isArray(entries)) return json({ error: "No entries given" }, 400);
  const skipWeekends = (await loadSettings(env)).skip_weekends === "1";
  const allowed = new Set(itemDates(item.scheduled_date || item.due_date, item.days, skipWeekends));
  // Hours belong to the person who did them: you, if you are on the item, otherwise its first person.
  const personId = peopleIds.includes(user.id) ? user.id : (peopleIds[0] || user.id);
  const timeOk = t => t === null || t === undefined || t === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

  const stmts = [];
  for (const e of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.work_date || "") || !allowed.has(e.work_date)) {
      return json({ error: `${e.work_date} is not one of this item's days` }, 400);
    }
    if (!timeOk(e.start_time) || !timeOk(e.end_time)) return json({ error: "Times must look like 09:30" }, 400);
    const st = e.start_time || null, en = e.end_time || null;
    if (!st && !en) {
      stmts.push(env.DB.prepare("DELETE FROM time_entries WHERE appointment_id = ? AND user_id = ? AND work_date = ?").bind(id, personId, e.work_date));
    } else {
      stmts.push(env.DB.prepare(`
        INSERT INTO time_entries (appointment_id, user_id, work_date, start_time, end_time, minutes)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(appointment_id, user_id, work_date)
        DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time, minutes = excluded.minutes
      `).bind(id, personId, e.work_date, st, en, minutesBetween(st, en)));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
}

async function handleDeleteAppointment(env, id) {
  await env.DB.prepare("DELETE FROM appointments WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ---------- router ----------

const READ_ONLY_MESSAGE = "This is a read-only account, so changes can't be saved.";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (path === "/api/setup" && method === "POST") return handleSetup(request, env);
      if (path === "/api/login" && method === "POST") return handleLogin(request, env);
      if (path === "/api/login/verify" && method === "POST") return handleVerifyCode(request, env);
      if (path === "/api/logout" && method === "POST") return handleLogout();
      if (path === "/api/public-settings" && method === "GET") return handlePublicSettings(env);
      if (path === "/api/logo" && method === "GET") return handleGetLogo(env);

      const user = await getUser(request, env);
      if (!user) return json({ error: "Not logged in" }, 401);

      // A viewer account is read-only: it may log in and out (handled above) but never save anything.
      if (user.role === "viewer" && method !== "GET") return json({ error: READ_ONLY_MESSAGE }, 403);

      if (path === "/api/me" && method === "GET") return json(user);

      if (path === "/api/settings" && method === "GET") return handleGetSettings(env);
      if (path === "/api/settings" && method === "PUT") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleUpdateSettings(request, env);
      }
      if (path === "/api/settings/logo" && method === "POST") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleUploadLogo(request, env);
      }
      if (path === "/api/settings/logo" && method === "DELETE") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleDeleteLogo(env);
      }

      if (path === "/api/users" && method === "GET") return handleListUsers(env);
      if (path === "/api/users" && method === "POST") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleCreateUser(request, env);
      }
      const userMatch = path.match(/^\/api\/users\/(\d+)$/);
      if (userMatch && method === "PUT") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleUpdateUser(request, env, userMatch[1]);
      }

      if (path === "/api/clients" && method === "GET") return handleListClients(env);
      if (path === "/api/clients" && method === "POST") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleCreateClient(request, env);
      }
      const clientMatch = path.match(/^\/api\/clients\/(\d+)$/);
      if (clientMatch && method === "PUT") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleUpdateClient(request, env, clientMatch[1]);
      }
      if (clientMatch && method === "DELETE") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleDeleteClient(env, clientMatch[1]);
      }

      if (path === "/api/job-types" && method === "GET") return handleListJobTypes(env);

      const commentsMatch = path.match(/^\/api\/appointments\/(\d+)\/comments$/);
      if (commentsMatch && method === "GET") return handleListComments(env, commentsMatch[1]);
      if (commentsMatch && method === "POST") return handleAddComment(request, env, user, commentsMatch[1]);

      const attachMatch = path.match(/^\/api\/appointments\/(\d+)\/attachments$/);
      if (attachMatch && method === "GET") return handleListAttachments(env, attachMatch[1]);
      if (attachMatch && method === "POST") return handleUploadAttachment(request, env, user, attachMatch[1]);

      const attachFileMatch = path.match(/^\/api\/attachments\/(\d+)\/file$/);
      if (attachFileMatch && method === "GET") return handleGetAttachmentFile(env, attachFileMatch[1]);

      const attachDeleteMatch = path.match(/^\/api\/attachments\/(\d+)$/);
      if (attachDeleteMatch && method === "DELETE") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleDeleteAttachment(env, attachDeleteMatch[1]);
      }

      if (path === "/api/sites" && method === "GET") return handleListSites(request, env);
      if (path === "/api/sites" && method === "POST") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleCreateSite(request, env);
      }
      const siteMatch = path.match(/^\/api\/sites\/(\d+)$/);
      if (siteMatch && method === "PUT") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleUpdateSite(request, env, siteMatch[1]);
      }
      if (siteMatch && method === "DELETE") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleDeleteSite(env, siteMatch[1]);
      }

      if (path === "/api/appointments" && method === "GET") return handleListAppointments(request, env, user);
      if (path === "/api/appointments" && method === "POST") return handleCreateAppointment(request, env, user);
      if (path === "/api/appointments/recurring" && method === "POST") return handleCreateRecurring(request, env, user);
      const seriesMatch = path.match(/^\/api\/appointments\/series\/([\w-]+)$/);
      if (seriesMatch && method === "DELETE") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleDeleteSeries(env, seriesMatch[1]);
      }
      const timeMatch = path.match(/^\/api\/appointments\/(\d+)\/time$/);
      if (timeMatch && method === "GET") return handleListTime(env, timeMatch[1]);
      if (timeMatch && method === "PUT") return handleSaveTime(request, env, user, timeMatch[1]);
      const apptMatch = path.match(/^\/api\/appointments\/(\d+)$/);
      if (apptMatch && method === "PUT") return handleUpdateAppointment(request, env, user, apptMatch[1]);
      if (apptMatch && method === "DELETE") {
        if (user.role !== "admin") return json({ error: "Admin only" }, 403);
        return handleDeleteAppointment(env, apptMatch[1]);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message || "Server error" }, 500);
    }
  },
};
