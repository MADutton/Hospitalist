// server.js — Render-safe, JSON-safe, Postgres-backed (no SQLite), auto-fetch CSVs from Google Sheets on startup
// Node 18+ (ESM). Render start: node server.js
//
// REQUIRED ENV (minimum):
//   AUTH_SECRET=some-long-random-string
//   BASE_URL=https://YOUR-SERVICE.onrender.com
//   OPENAI_API_KEY=sk-...
//   DATABASE_URL=postgres://...          (Render Postgres connection string)
//
// OPTIONAL ENV:
//   DEV_LOGIN=true                       (enables POST /auth/dev-login)
//   ADMIN_EMAIL=you@domain.com            (bypass allowed_users.csv; always role=admin)
//   SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM (only needed if using magic-link email auth)
//
// OPTIONAL ENV (still useful even with Postgres):
//   DATA_DIR=/var/data                    (for cached CSVs + transcripts; NOT required for DB)
//   TRANSCRIPTS_DIR=/var/data/transcripts (defaults under DATA_DIR)
//
// GOOGLE SHEETS CSV URL ENVS (recommended):
//   USERS_CSV_URL=...
//   CASES_CSV_URL=...
//   UI_TEXT_CSV_URL=...
//   ONLINE_REFS_CSV_URL=...
//   MASTERY_RULES_CSV_URL=...
//   MODULE_CONTROLS_CSV_URL=...   (optional; stored + served for future use)

import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";
import pg from "pg";

import { csvToObjects, readCsvFileToObjects, objectsToCsv } from "./csv_tools.js";

// -------------------- Crash guards --------------------
process.on("uncaughtException", (e) => console.error("UNCAUGHT:", e?.stack || e));
process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e?.stack || e));
console.log("BOOT: starting server.js");

// -------------------- Paths / constants --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 10000);

// Cache/storage paths (NOT database)
const DATA_DIR = process.env.DATA_DIR || "/var/data";

const CASES_CSV_PATH = process.env.CASES_CSV_PATH || path.join(DATA_DIR, "cases.csv");
const USERS_CSV_PATH = process.env.USERS_CSV_PATH || path.join(DATA_DIR, "allowed_users.csv");
const RULES_CSV_PATH = process.env.RULES_CSV_PATH || path.join(DATA_DIR, "mastery_rules.csv");
const UI_CSV_PATH = process.env.UI_CSV_PATH || path.join(DATA_DIR, "ui_text.csv");
const ONLINE_REFS_CSV_PATH = process.env.ONLINE_REFS_CSV_PATH || path.join(DATA_DIR, "online_refs.csv");
const MODULE_CONTROLS_CSV_PATH =
  process.env.MODULE_CONTROLS_CSV_PATH || path.join(DATA_DIR, "module_controls.csv");

const TRANSCRIPTS_DIR = process.env.TRANSCRIPTS_DIR || path.join(DATA_DIR, "transcripts");

// Static root (serve files from /public if present, else repo root)
const STATIC_ROOT = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

// Ensure dirs exist early (safe even if no disk mounted; will fail gracefully)
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
} catch (e) {
  console.error("BOOT: mkdir failed:", e?.stack || e);
}

// -------------------- Postgres --------------------
const { Pool } = pg;

function requireDatabaseUrl() {
  const u = process.env.DATABASE_URL || "";
  if (!u) throw new Error("Missing DATABASE_URL env var (Render Postgres).");
  return u;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  // Render Postgres typically requires SSL; this setting works for Render-managed DBs.
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  // events: replaces SQLite events table
  // rmv_submissions: explicit RMV submissions table (reflection + payload)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      ts BIGINT NOT NULL,
      email TEXT NOT NULL,
      module TEXT,
      case_id TEXT,
      event_type TEXT NOT NULL,
      details_json JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_events_email_ts ON events (email, ts);
    CREATE INDEX IF NOT EXISTS idx_events_case ON events (case_id);

    CREATE TABLE IF NOT EXISTS rmv_submissions (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      email TEXT NOT NULL,
      module_id TEXT NOT NULL,
      mastery BOOLEAN NOT NULL DEFAULT FALSE,
      reflection TEXT NOT NULL,
      aml_payload JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_rmv_email_created ON rmv_submissions (email, created_at);
    CREATE INDEX IF NOT EXISTS idx_rmv_module_created ON rmv_submissions (module_id, created_at);
  `);
}

async function trackEvent({ email, module, case_id, event_type, details }) {
  await pool.query(
    `INSERT INTO events (ts, email, module, case_id, event_type, details_json)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      Date.now(),
      email,
      module || null,
      case_id || null,
      event_type,
      details ?? null,
    ]
  );
}

// -------------------- Small helpers --------------------
function normalizeEmail(email) {
  const e = (email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return null;
  return e;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const [k, ...v] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(v.join("=") || "");
  });
  return out;
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function apiError(res, status, message, details = null) {
  const payload = { error: message };
  if (details !== null && details !== undefined) payload.details = details;
  return json(res, status, payload);
}

function text(res, status, msg) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(msg);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";
  return "text/plain; charset=utf-8";
}

function safePathFromUrl(urlPath) {
  let p = (urlPath || "/").split("?")[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  if (p === "/") p = "/index.html";
  if (p.includes("..")) return null;
  return p;
}

async function readBody(req, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// -------------------- Bootstrapping CSVs from repo to disk (fallback) --------------------
function bootstrapCsvToDisk(filename) {
  const diskPath = path.join(DATA_DIR, filename);

  if (fs.existsSync(diskPath)) {
    console.log(`Bootstrap: ${filename} already on disk at ${diskPath}`);
    return;
  }

  const candidates = [
    path.join(__dirname, filename),
    path.join(__dirname, "data", filename),
    path.join(__dirname, "config", filename),
    path.join(__dirname, "content", filename),
    path.join(__dirname, "public", filename),
  ];

  const repoPath = candidates.find((p) => fs.existsSync(p));
  if (!repoPath) {
    console.log(`Bootstrap: ${filename} NOT found in repo. Checked:`);
    for (const c of candidates) console.log(`  - ${c}`);
    return;
  }

  try {
    fs.copyFileSync(repoPath, diskPath);
    console.log(`Bootstrapped ${filename} -> ${diskPath} (from ${repoPath})`);
  } catch (e) {
    console.error(`Bootstrap copy failed for ${filename}:`, e?.stack || e);
  }
}

// Fallback bootstrap (won’t crash if missing)
bootstrapCsvToDisk("allowed_users.csv");
bootstrapCsvToDisk("mastery_rules.csv");
bootstrapCsvToDisk("ui_text.csv");
bootstrapCsvToDisk("cases.csv");
bootstrapCsvToDisk("online_refs.csv");
bootstrapCsvToDisk("module_controls.csv");

// -------------------- Auto-fetch Google Sheets CSVs on startup --------------------
async function fetchCsvToPath(url, outPath) {
  if (!url) return { ok: false, skipped: true, reason: "No URL set" };

  const resp = await fetch(url, { method: "GET" });
  const body = await resp.text();

  if (!resp.ok) {
    return { ok: false, status: resp.status, sample: body.slice(0, 200) };
  }

  // Basic sanity check: should look like CSV with at least one comma or newline
  const looksLikeCsv = body.includes("\n") || body.includes(",");
  if (!looksLikeCsv) {
    return { ok: false, status: 200, sample: body.slice(0, 200), reason: "Does not look like CSV" };
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body, "utf8");
  return { ok: true, status: resp.status, bytes: body.length };
}

async function refreshAllCsvFromEnv() {
  const plan = [
    { env: "USERS_CSV_URL", path: USERS_CSV_PATH },
    { env: "CASES_CSV_URL", path: CASES_CSV_PATH },
    { env: "UI_TEXT_CSV_URL", path: UI_CSV_PATH },
    { env: "ONLINE_REFS_CSV_URL", path: ONLINE_REFS_CSV_PATH },
    { env: "MASTERY_RULES_CSV_URL", path: RULES_CSV_PATH },
    { env: "MODULE_CONTROLS_CSV_URL", path: MODULE_CONTROLS_CSV_PATH },
  ];

  const results = [];
  for (const item of plan) {
    const url = process.env[item.env] || "";
    try {
      const r = await fetchCsvToPath(url, item.path);
      results.push({ env: item.env, out: item.path, ...r });
    } catch (e) {
      results.push({ env: item.env, out: item.path, ok: false, error: e?.message || String(e) });
    }
  }
  return results;
}

// -------------------- Auth: signed cookie session --------------------
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 min
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const magicTokens = new Map(); // tokenHash -> { email, expiresAt }

function base64urlEncode(s) {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64urlDecodeToUtf8(b64url) {
  const b64 = b64url.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

function requireSecret() {
  const secret = process.env.AUTH_SECRET || "";
  if (!secret) throw new Error("Missing AUTH_SECRET env var");
  return secret;
}

function signSession(email, expiresAtMs) {
  const secret = requireSecret();
  const payload = JSON.stringify({ email, exp: expiresAtMs });
  const payloadB64 = base64urlEncode(payload);
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${payloadB64}.${sig}`;
}

function verifySession(token) {
  const secret = process.env.AUTH_SECRET || "";
  if (!secret) return null;
  if (!token || !token.includes(".")) return null;

  const [payloadB64, sig] = token.split(".");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

  if (sig !== expected) return null;

  let payload;
  try {
    payload = JSON.parse(base64urlDecodeToUtf8(payloadB64));
  } catch {
    return null;
  }
  if (!payload?.email || !payload?.exp) return null;
  if (Date.now() > payload.exp) return null;
  return payload.email;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000
    )}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

// -------------------- CSV-backed caches --------------------
let allowedUsers = new Map(); // email -> { role, cohort }
let masteryRules = new Map(); // module -> rule object
let uiText = {}; // key -> text
let casesCache = []; // array of case objects
let moduleControls = []; // optional future config

function loadAllowedUsersFromCsv() {
  if (!fs.existsSync(USERS_CSV_PATH)) {
    allowedUsers = new Map();
    console.log(`allowed_users.csv not found at ${USERS_CSV_PATH}`);
    return;
  }
  const rows = readCsvFileToObjects(USERS_CSV_PATH);
  const map = new Map();
  for (const r of rows) {
    const email = normalizeEmail(r.email);
    if (!email) continue;
    const role = (r.role || "learner").trim().toLowerCase();
    const cohort = (r.cohort || "").trim();
    map.set(email, { role: role || "learner", cohort });
  }
  allowedUsers = map;
  console.log(`Loaded ${allowedUsers.size} users from ${USERS_CSV_PATH}`);
}

function loadMasteryRulesFromCsv() {
  if (!fs.existsSync(RULES_CSV_PATH)) {
    masteryRules = new Map();
    console.log(`mastery_rules.csv not found at ${RULES_CSV_PATH}`);
    return;
  }
  const rows = readCsvFileToObjects(RULES_CSV_PATH);
  const map = new Map();
  for (const r of rows) {
    const module = (r.module || "").trim().toLowerCase();
    if (!module) continue;
    map.set(module, {
      module,
      min_attempts: Number(r.min_attempts || 1),
      require_confidence: String(r.require_confidence || "false").toLowerCase() === "true",
      final_question_style: (r.final_question_style || "principle_based").trim(),
      allow_transcript: String(r.allow_transcript || "true").toLowerCase() === "true",
      allow_online_refs: String(r.allow_online_refs || "false").toLowerCase() === "true",
    });
  }
  masteryRules = map;
  console.log(`Loaded ${masteryRules.size} mastery rules from ${RULES_CSV_PATH}`);
}

function loadUiTextFromCsv() {
  if (!fs.existsSync(UI_CSV_PATH)) {
    uiText = {};
    console.log(`ui_text.csv not found at ${UI_CSV_PATH}`);
    return;
  }
  const rows = readCsvFileToObjects(UI_CSV_PATH);
  const obj = {};
  for (const r of rows) {
    const key = (r.key || "").trim();
    if (!key) continue;
    obj[key] = r.text ?? "";
  }
  uiText = obj;
  console.log(`Loaded ${Object.keys(uiText).length} UI text entries from ${UI_CSV_PATH}`);
}

function loadCasesFromCsv() {
  if (!fs.existsSync(CASES_CSV_PATH)) {
    casesCache = [];
    console.log(`cases.csv not found at ${CASES_CSV_PATH}`);
    return;
  }
  const textData = fs.readFileSync(CASES_CSV_PATH, "utf8");
  casesCache = csvToObjects(textData).filter((c) => (c.id || "").trim() !== "");
  console.log(`Loaded ${casesCache.length} cases from ${CASES_CSV_PATH}`);
}

function loadModuleControlsFromCsv() {
  if (!fs.existsSync(MODULE_CONTROLS_CSV_PATH)) {
    moduleControls = [];
    console.log(`module_controls.csv not found at ${MODULE_CONTROLS_CSV_PATH}`);
    return;
  }
  const textData = fs.readFileSync(MODULE_CONTROLS_CSV_PATH, "utf8");
  moduleControls = csvToObjects(textData);
  console.log(`Loaded ${moduleControls.length} module_controls rows from ${MODULE_CONTROLS_CSV_PATH}`);
}

function startupLoad() {
  try { loadAllowedUsersFromCsv(); } catch (e) { console.log("Users load error:", e.message); }
  try { loadMasteryRulesFromCsv(); } catch (e) { console.log("Rules load error:", e.message); }
  try { loadUiTextFromCsv(); } catch (e) { console.log("UI load error:", e.message); }
  try { loadCasesFromCsv(); } catch (e) { console.log("Cases load error:", e.message); }
  try { loadModuleControlsFromCsv(); } catch (e) { console.log("Module controls load error:", e.message); }
}

// -------------------- Auth helpers (roles / allowlist) --------------------
function getUserRole(email) {
  const admin = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (admin && email === admin) return "admin";
  return allowedUsers.get(email)?.role || null;
}

function isAllowedEmail(email) {
  if (!email) return false;

  const admin = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (admin && email === admin) return true;

  return allowedUsers.has(email);
}

function requireAuth(req, res) {
  const cookies = parseCookies(req);
  const email = verifySession(cookies.session);
  if (!email) {
    apiError(res, 401, "Unauthorized");
    return null;
  }
  return email;
}

function requireFaculty(req, res) {
  const email = requireAuth(req, res);
  if (!email) return null;
  const role = getUserRole(email);
  if (role !== "faculty" && role !== "admin") {
    apiError(res, 403, "Forbidden");
    return null;
  }
  return email;
}

// -------------------- SMTP (magic link email) --------------------
function mailer() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) {
    throw new Error("Missing SMTP env vars (SMTP_HOST/PORT/USER/PASS).");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

// -------------------- Transcripts + curated refs --------------------
function loadTranscriptText(slug) {
  if (!slug) return null;
  const safe = String(slug).replace(/[^a-zA-Z0-9_\-]/g, "");
  const p = path.join(TRANSCRIPTS_DIR, `${safe}.txt`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

function loadOnlineRefsForModule(module) {
  if (!fs.existsSync(ONLINE_REFS_CSV_PATH)) return [];
  const rows = readCsvFileToObjects(ONLINE_REFS_CSV_PATH);
  return rows.filter(
    (r) =>
      (r.topic || "").trim().toLowerCase() === module.toLowerCase() &&
      (r.status || "active").trim().toLowerCase() !== "deprecated"
  );
}

// -------------------- OpenAI wrapper --------------------
function extractTextFromResponsesAPI(data) {
  try {
    const out = data?.output || [];
    const parts = [];
    for (const item of out) {
      const content = item?.content || [];
      for (const seg of content) {
        if ((seg.type === "output_text" || seg.type === "text") && seg.text) parts.push(seg.text);
      }
    }
    if (!parts.length && data?.output_text) return String(data.output_text);
    return parts.join("\n").trim();
  } catch {
    return "";
  }
}

async function callOpenAI({ model, input, transcriptText, onlineRefsText }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Server missing OPENAI_API_KEY env var.");

  const systemParts = [];
  systemParts.push(
    `You are a veterinary clinical reasoning tutor for exam preparation.
Be concise and clinically accurate.
Do not disclose or simulate real ABVP exam content.
If asked for exact drug dosages not present in provided course materials, say it’s out of scope and direct the learner to remediation/course material.
If COURSE MATERIAL is provided, prioritize it as the source of truth.`
  );

  const MAX_TRANSCRIPT_CHARS = Number(process.env.MAX_TRANSCRIPT_CHARS || "8000");

  if (transcriptText) {
    const trimmed = String(transcriptText).slice(0, MAX_TRANSCRIPT_CHARS);
    systemParts.push(
      `COURSE MATERIAL (PPTX/MP4 transcript). Use as primary source. If you extrapolate, label it as extrapolation.`
    );
    systemParts.push(`COURSE MATERIAL:\n"""${trimmed}"""`);
  }

  if (onlineRefsText) {
    systemParts.push(`CURATED ONLINE NOTES (secondary). Use only if course material does not address the point.`);
    systemParts.push(`CURATED ONLINE NOTES:\n"""${onlineRefsText}"""`);
  }

  const system = systemParts.join("\n\n");

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: input },
      ],
    }),
  });

  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

// -------------------- Route handlers --------------------
async function handleHealth(req, res) {
  return text(res, 200, "ok");
}

async function handleDevLogin(req, res) {
  if (process.env.DEV_LOGIN !== "true") return apiError(res, 404, "Not found");

  const raw = await readBody(req);
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch {}

  const normalized = normalizeEmail(parsed.email);
  if (!normalized) return apiError(res, 400, "Invalid email format.");
  if (!isAllowedEmail(normalized)) return apiError(res, 403, "Email not authorized.");

  const sessionToken = signSession(normalized, Date.now() + SESSION_TTL_MS);
  setSessionCookie(res, sessionToken);
  return json(res, 200, { ok: true });
}

async function handleAuthRequest(req, res) {
  const raw = await readBody(req);
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch {}

  const normalized = normalizeEmail(parsed.email);
  if (!normalized) return apiError(res, 400, "Invalid email format.");
  if (!isAllowedEmail(normalized)) return apiError(res, 403, "Email not authorized.");

  const baseUrl = process.env.BASE_URL || "";
  if (!baseUrl) return apiError(res, 500, "Missing BASE_URL env var.");

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  magicTokens.set(tokenHash, { email: normalized, expiresAt: Date.now() + MAGIC_LINK_TTL_MS });

  const link = `${baseUrl}/auth/verify?token=${token}`;

  try {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    const t = mailer();
    await t.sendMail({
      from,
      to: normalized,
      subject: "Your AI Clinical Lab sign-in link",
      text: `Click to sign in (expires in 15 minutes):\n\n${link}\n\nIf you did not request this, ignore.`,
    });
  } catch (e) {
    return apiError(res, 500, "Email sign-in is not configured.", e?.message || String(e));
  }

  return json(res, 200, { ok: true });
}

async function handleAuthVerify(req, res, urlObj) {
  const token = urlObj.searchParams.get("token") || "";
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const entry = magicTokens.get(tokenHash);

  if (!entry || Date.now() > entry.expiresAt) {
    magicTokens.delete(tokenHash);
    res.writeHead(302, { Location: "/?login=expired" });
    res.end();
    return;
  }

  magicTokens.delete(tokenHash);

  const sessionToken = signSession(entry.email, Date.now() + SESSION_TTL_MS);
  setSessionCookie(res, sessionToken);

  res.writeHead(302, { Location: "/" });
  res.end();
}

async function handleAuthMe(req, res) {
  const cookies = parseCookies(req);
  const email = verifySession(cookies.session);
  const role = email ? getUserRole(email) : null;
  return json(res, 200, { email: email || null, role: role || null });
}

async function handleAuthLogout(req, res) {
  clearSessionCookie(res);
  return json(res, 200, { ok: true });
}

async function handleConfigUiText(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;
  return json(res, 200, uiText);
}

async function handleConfigMasteryRules(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;
  return json(res, 200, Array.from(masteryRules.values()));
}

async function handleConfigModuleControls(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;
  return json(res, 200, moduleControls);
}

async function handleCases(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;
  return json(res, 200, casesCache);
}

async function handleTrack(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;

  const raw = await readBody(req);
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch {}

  const { module, case_id, event_type, details, preview } = parsed;

  if (preview === true) return json(res, 200, { ok: true, skipped: "preview" });
  if (!event_type) return apiError(res, 400, "Missing event_type");

  await trackEvent({
    email,
    module: (module || "").toLowerCase() || null,
    case_id: case_id || null,
    event_type,
    details,
  });

  return json(res, 200, { ok: true });
}

// NEW: RMV submission endpoint (for your Week 1 module)
async function handleRmvSubmit(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;

  const raw = await readBody(req, 2_000_000);
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch {}

  const module_id = String(parsed.module_id || "").trim();
  const reflection = String(parsed.reflection || "").trim();
  const masteryRaw = parsed.mastery;
  const mastery =
    masteryRaw === true ||
    masteryRaw === "true" ||
    masteryRaw === 1 ||
    masteryRaw === "1";

  let aml_payload = parsed.aml_payload ?? null;
  // If client sent aml_payload as a JSON string, parse it
  if (typeof aml_payload === "string") {
    try { aml_payload = JSON.parse(aml_payload); } catch { /* keep as string */ }
  }

  if (!module_id) return apiError(res, 400, "Missing module_id");
  if (!reflection) return apiError(res, 400, "Missing reflection");

  // Store in rmv_submissions table
  await pool.query(
    `INSERT INTO rmv_submissions (email, module_id, mastery, reflection, aml_payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [email, module_id, mastery, reflection, aml_payload]
  );

  // Also track an event for unified reporting
  await trackEvent({
    email,
    module: module_id.toLowerCase(),
    case_id: null,
    event_type: "rmv_submitted",
    details: { mastery, reflection_len: reflection.length },
  });

  return json(res, 200, { ok: true });
}

async function handleExportUsersSummary(req, res) {
  const admin = requireFaculty(req, res);
  if (!admin) return;

  const { rows } = await pool.query(`
    SELECT email,
           MAX(ts) as last_active,
           SUM(CASE WHEN event_type='attempt_submitted' THEN 1 ELSE 0 END) as attempts,
           SUM(CASE WHEN event_type='mastery_pass' THEN 1 ELSE 0 END) as mastered
    FROM events
    GROUP BY email
  `);

  const out = rows.map((r) => {
    const attempts = Number(r.attempts || 0);
    const mastered = Number(r.mastered || 0);
    const mastery_rate = attempts > 0 ? mastered / attempts : 0;
    const lastActiveMs = r.last_active ? Number(r.last_active) : null;
    return {
      email: r.email,
      attempts,
      mastered,
      mastery_rate: (mastery_rate * 100).toFixed(1) + "%",
      last_active: lastActiveMs ? new Date(lastActiveMs).toISOString() : "",
    };
  });

  const csv = objectsToCsv(out, ["email", "attempts", "mastered", "mastery_rate", "last_active"]);
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
  res.end(csv);
}

async function handleExportCaseDetail(req, res) {
  const admin = requireFaculty(req, res);
  if (!admin) return;

  const { rows } = await pool.query(`
    SELECT email, case_id,
           SUM(CASE WHEN event_type='attempt_submitted' THEN 1 ELSE 0 END) as attempts,
           SUM(CASE WHEN event_type='mastery_pass' THEN 1 ELSE 0 END) as mastery_passes,
           MIN(ts) as first_seen,
           MAX(ts) as last_seen
    FROM events
    WHERE case_id IS NOT NULL AND case_id <> ''
    GROUP BY email, case_id
  `);

  const out = rows.map((r) => ({
    email: r.email,
    case_id: r.case_id,
    attempts: Number(r.attempts || 0),
    mastered: Number(r.mastery_passes || 0) > 0 ? "yes" : "no",
    first_seen: r.first_seen ? new Date(Number(r.first_seen)).toISOString() : "",
    last_seen: r.last_seen ? new Date(Number(r.last_seen)).toISOString() : "",
  }));

  const csv = objectsToCsv(out, ["email", "case_id", "attempts", "mastered", "first_seen", "last_seen"]);
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
  res.end(csv);
}

// Optional: export RMV submissions as CSV (faculty only)
async function handleExportRmv(req, res) {
  const admin = requireFaculty(req, res);
  if (!admin) return;

  const { rows } = await pool.query(`
    SELECT created_at, email, module_id, mastery, reflection
    FROM rmv_submissions
    ORDER BY created_at DESC
    LIMIT 5000
  `);

  const out = rows.map((r) => ({
    created_at: r.created_at ? new Date(r.created_at).toISOString() : "",
    email: r.email,
    module_id: r.module_id,
    mastery: r.mastery ? "true" : "false",
    reflection: r.reflection,
  }));

  const csv = objectsToCsv(out, ["created_at", "email", "module_id", "mastery", "reflection"]);
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
  res.end(csv);
}

async function handleChat(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;

  const raw = await readBody(req, 2_000_000);
  let parsed = {};
  try { parsed = JSON.parse(raw || "{}"); } catch {}

  const { input, model, case_id, module, transcript_slug } = parsed;
  if (!input) return apiError(res, 400, "Missing 'input'.");

  const mod = (module || "").toLowerCase();
  const rules = masteryRules.get(mod) || { allow_transcript: true, allow_online_refs: false };

  const transcriptText = rules.allow_transcript ? loadTranscriptText(transcript_slug) : null;

  let onlineRefsText = null;
  if (rules.allow_online_refs) {
    const refs = loadOnlineRefsForModule(mod);
    if (refs.length) {
      onlineRefsText = refs
        .map((r) => `SOURCE: ${r.source || "ref"}\n${r.content || ""}`)
        .join("\n\n---\n\n");
    }
  }

  await trackEvent({
    email,
    module: mod || null,
    case_id: case_id || null,
    event_type: "chat_called",
    details: { has_transcript: !!transcriptText },
  });

  try {
    const upstream = await callOpenAI({ model, input, transcriptText, onlineRefsText });

    if (upstream.status < 200 || upstream.status >= 300) {
      return apiError(res, 502, "Upstream model error", upstream.data?.error || upstream.data);
    }

    const assistantText = extractTextFromResponsesAPI(upstream.data);
    if (!assistantText) {
      return apiError(res, 502, "Upstream response had no text.", upstream.data);
    }

    return json(res, 200, {
      text: assistantText,
      meta: { model: model || "gpt-4o-mini" },
    });
  } catch (e) {
    return apiError(res, 500, e?.message || String(e));
  }
}

// Optional: force-refresh Google Sheets CSVs (admin-only) without UI
async function handleAdminRefreshConfig(req, res) {
  const admin = requireFaculty(req, res);
  if (!admin) return;

  const results = await refreshAllCsvFromEnv();
  startupLoad();
  return json(res, 200, { ok: true, results });
}

// -------------------- Static serving --------------------
function serveStatic(req, res) {
  const p = safePathFromUrl(req.url);
  if (!p) return text(res, 400, "Bad request");

  const filePath = path.join(STATIC_ROOT, p);

  if (!fs.existsSync(filePath)) return text(res, 404, "Not found");
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return text(res, 404, "Not found");

  const file = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
  res.end(file);
}

// -------------------- Router --------------------
const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = urlObj.pathname;

    // Health first
    if (req.method === "GET" && pathname === "/health") return await handleHealth(req, res);

    // Auth
    if (req.method === "POST" && pathname === "/auth/dev-login") return await handleDevLogin(req, res);
    if (req.method === "POST" && pathname === "/auth/request") return await handleAuthRequest(req, res);
    if (req.method === "GET" && pathname === "/auth/verify") return await handleAuthVerify(req, res, urlObj);
    if (req.method === "GET" && pathname === "/auth/me") return await handleAuthMe(req, res);
    if (req.method === "POST" && pathname === "/auth/logout") return await handleAuthLogout(req, res);

    // Config
    if (req.method === "GET" && pathname === "/config/ui_text") return await handleConfigUiText(req, res);
    if (req.method === "GET" && pathname === "/config/mastery_rules") return await handleConfigMasteryRules(req, res);
    if (req.method === "GET" && pathname === "/config/module_controls") return await handleConfigModuleControls(req, res);

    // Cases
    if (req.method === "GET" && pathname === "/cases.json") return await handleCases(req, res);

    // Tracking
    if (req.method === "POST" && pathname === "/track") return await handleTrack(req, res);

    // RMV submit (NEW)
    if (req.method === "POST" && pathname === "/api/rmv/submit") return await handleRmvSubmit(req, res);

    // Exports (faculty only)
    if (req.method === "GET" && pathname === "/admin/export/users_summary.csv") return await handleExportUsersSummary(req, res);
    if (req.method === "GET" && pathname === "/admin/export/case_detail.csv") return await handleExportCaseDetail(req, res);
    if (req.method === "GET" && pathname === "/admin/export/rmv.csv") return await handleExportRmv(req, res);

    // Admin refresh (faculty only)
    if (req.method === "POST" && pathname === "/admin/refresh-config") return await handleAdminRefreshConfig(req, res);

    // OpenAI proxy
    if (req.method === "POST" && pathname === "/api/chat") return await handleChat(req, res);

    // Static last
    return serveStatic(req, res);
  } catch (e) {
    return apiError(res, 500, e?.message || String(e));
  }
});

// -------------------- LISTEN (Render needs this!) --------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log("LISTENING:", { port: PORT, node: process.version });
  console.log("Static root:", STATIC_ROOT);
  console.log("Data dir:", DATA_DIR);
});

// -------------------- POST-LISTEN BOOT: init DB + fetch Google CSVs + load caches --------------------
(async () => {
  try {
    // Ensure DATABASE_URL is present (fail early with clear error)
    requireDatabaseUrl();

    await initDb();
    console.log("BOOT: Postgres initDb complete");

    const results = await refreshAllCsvFromEnv();
    console.log("BOOT: CSV refresh results:", results);

    startupLoad();
    console.log("BOOT: startupLoad complete");
  } catch (e) {
    console.error("POST-LISTEN BOOT ERROR:", e?.stack || e);
    // Keep server running; app can use disk-bootstrapped CSVs if present
    try { startupLoad(); } catch {}
  }
})();
