/**
 * worker.js (CommonJS) — Production-safe execution worker for Railway.
 *
 * Fixes:
 *  - Picks only runnable jobs: status='queued' AND (run_at is null OR run_at <= now()) AND unclaimed
 *  - Reads TYPES from TYPES or WORKER_TYPES (either works)
 *  - Strong queue audit to prove whether jobs exist in the DB
 *  - Clear logging of SUPABASE_URL hostname to catch “wrong project” instantly
 *
 * Env vars expected:
 *  - SUPABASE_URL
 *  - SUPABASE_SERVICE_KEY
 *  - WORKER_ENABLED
 *  - WORKER_ID
 *  - TYPES (or WORKER_TYPES)
 *  - POLL_MS
 *  - HEARTBEAT_SECS
 *  - JOB_TIMEOUT_MS
 *  - WORKER_WEBHOOK_URL
 *  - API_SECRET
 */

const { createClient } = require("@supabase/supabase-js");

// ---------- helpers ----------
function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function log(obj) {
  console.log(JSON.stringify(obj));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null) return fallback;
  return String(v).toLowerCase() === "true" || String(v) === "1";
}

function envInt(name, fallback) {
  const v = process.env[name];
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function safeTrim(v) {
  return String(v || "").trim();
}

function parseTypes(raw) {
  if (!raw) return ["execute_intent"];
  const s = String(raw).trim();
  if (!s) return ["execute_intent"];

  // JSON array support
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr.length) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch {}
  }

  // CSV/space support
  return s
    .split(/[,\s]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeWebhookUrl(u) {
  return safeTrim(u);
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ---------- config ----------
const TAG = "AUX";

const WORKER_ENABLED = envBool("WORKER_ENABLED", true);
const WORKER_ID = safeTrim(process.env.WORKER_ID || "ladder-worker-1");

// Support BOTH env var names (your Railway UI shows both exist)
const TYPES = parseTypes(process.env.TYPES || process.env.WORKER_TYPES || "execute_intent");

const POLL_MS = envInt("POLL_MS", 2000);
const HEARTBEAT_SECS = envInt("HEARTBEAT_SECS", 20);
const JOB_TIMEOUT_MS = envInt("JOB_TIMEOUT_MS", 60000);

const SUPABASE_URL = safeTrim(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_KEY = safeTrim(process.env.SUPABASE_SERVICE_KEY || "");

const WORKER_WEBHOOK_URL = normalizeWebhookUrl(process.env.WORKER_WEBHOOK_URL || process.env.WEBHOOK_URL || "");
const API_SECRET = safeTrim(process.env.API_SECRET || "");

const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const hasWebhook = Boolean(WORKER_WEBHOOK_URL);
const hasApiSecret = Boolean(API_SECRET);

const SUPABASE_HOST = hostnameOf(SUPABASE_URL);
const WEBHOOK_HOST = hostnameOf(WORKER_WEBHOOK_URL);

// ---------- start log ----------
log({
  tag: TAG,
  msg: "WORKER_STARTED",
  ts: nowIso(),
  WORKER_ENABLED,
  WORKER_ID,
  TYPES,
  POLL_MS,
  HEARTBEAT_SECS,
  JOB_TIMEOUT_MS,
  hasSupabase,
  hasWebhook,
  hasApiSecret,
  supabase_host: SUPABASE_HOST,
  webhook_host: WEBHOOK_HOST,
  // show first chars only (safe)
  webhook_url_prefix: WORKER_WEBHOOK_URL ? WORKER_WEBHOOK_URL.slice(0, 60) : "",
});

// If disabled, exit cleanly
if (!WORKER_ENABLED) {
  log({ tag: TAG, msg: "WORKER_DISABLED_BY_ENV", ts: nowIso() });
  setTimeout(() => process.exit(0), 250);
  return;
}

if (!hasSupabase) {
  log({
    tag: TAG,
    msg: "FATAL_MISSING_SUPABASE_ENV",
    ts: nowIso(),
    need: ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"],
  });
  process.exit(1);
}

if (!hasWebhook) {
  log({
    tag: TAG,
    msg: "FATAL_MISSING_WEBHOOK_URL",
    ts: nowIso(),
    hint: "Set WORKER_WEBHOOK_URL (or WEBHOOK_URL) to ladder-bot /webhook/worker",
  });
  process.exit(1);
}

if (!hasApiSecret) {
  log({
    tag: TAG,
    msg: "FATAL_MISSING_API_SECRET",
    ts: nowIso(),
    hint: "Set API_SECRET (must match ladder-bot API_SECRET) or you will get 401",
  });
  process.exit(1);
}

// ---------- supabase client ----------
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------- queue audit (proves whether jobs exist) ----------
async function queueAudit(types) {
  // 1) total queued (all types)
  const q1 = sb
    .from("execution_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued");

  // 2) queued + unclaimed + runnable by time (for our types)
  // We don’t trust run_at not-null; treat null as runnable.
  // Supabase filter for "run_at <= now()" via raw SQL isn’t available here,
  // so we fetch a small sample ordered by run_at and decide in JS.
  const q2 = sb
    .from("execution_jobs")
    .select("id,run_at,claimed_by,type,status,created_at")
    .eq("status", "queued")
    .is("claimed_by", null)
    .in("type", types)
    .order("run_at", { ascending: true, nullsFirst: true })
    .limit(10);

  const [{ count: totalQueued, error: e1 }, { data: sample, error: e2 }] = await Promise.all([q1, q2]);
  if (e1) throw e1;
  if (e2) throw e2;

  const now = new Date();
  const runnable = (sample || []).filter((j) => {
    if (!j.run_at) return true;
    const t = new Date(j.run_at);
    return Number.isFinite(t.getTime()) && t.getTime() <= now.getTime();
  });

  log({
    tag: TAG,
    msg: "QUEUE_AUDIT",
    ts: nowIso(),
    totalQueued: totalQueued ?? null,
    unclaimedQueuedSample: (sample || []).length,
    runnableSampleIds: runnable.map((x) => x.id),
    oldest_run_at: sample && sample[0] ? sample[0].run_at : null,
    types,
  });
}

// ---------- core DB ops ----------
async function pickQueuedJob(types) {
  // Pull a small batch then choose the first runnable in JS
  const { data, error } = await sb
    .from("execution_jobs")
    .select("id,type,status,payload,attempts,created_at,claimed_by,claimed_at,heartbeat_at,last_step,run_at,last_error")
    .in("type", types)
    .eq("status", "queued")
    .is("claimed_by", null)
    .order("run_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(25);

  if (error) throw error;

  const now = Date.now();
  const runnable = (data || []).find((j) => {
    if (!j.run_at) return true;
    const t = new Date(j.run_at).getTime();
    return Number.isFinite(t) && t <= now;
  });

  if (!runnable) {
    log({
      tag: TAG,
      msg: "PICK_DEBUG",
      ts: nowIso(),
      queued_seen: (data || []).length,
      oldest_run_at: data && data[0] ? data[0].run_at : null,
      runnable_found: false,
    });
    return null;
  }

  log({
    tag: TAG,
    msg: "PICK_DEBUG",
    ts: nowIso(),
    queued_seen: (data || []).length,
    oldest_run_at: data && data[0] ? data[0].run_at : null,
    runnable_found: true,
    picked_id: runnable.id,
    picked_run_at: runnable.run_at || null,
  });

  return runnable;
}

async function claimJob(jobId) {
  const now = nowIso();
  const { data, error } = await sb
    .from("execution_jobs")
    .update({
      status: "running",
      claimed_by: WORKER_ID,
      claimed_at: now,
      heartbeat_at: now,
      last_step: "claimed",
      last_error: null,
    })
    .eq("id", jobId)
    .eq("status", "queued")
    .is("claimed_by", null)
    .select("id,type,status,payload,attempts,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at")
    .limit(1);

  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function completeJob(jobId) {
  const now = nowIso();
  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "completed",
      heartbeat_at: now,
      last_step: "completed",
    })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID);

  if (error) throw error;
}

async function failJob(jobId, lastErrorCode, detail) {
  const now = nowIso();
  const code = safeTrim(lastErrorCode) || "unknown_error";
  const msg = safeTrim(detail).slice(0, 500);

  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "failed",
      heartbeat_at: now,
      last_step: "failed",
      last_error: code + (msg ? `: ${msg}` : ""),
    })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID);

  if (error) throw error;
}

// ---------- webhook execution ----------
async function executeViaWebhook(job) {
  const body = {
    job_id: job.id,
    type: job.type,
    payload: job.payload || {},
    worker_id: WORKER_ID,
    ts: nowIso(),
  };

  const headers = {
    "content-type": "application/json",
    "x-api-secret": API_SECRET,
    "x-api-key": API_SECRET,
    authorization: `Bearer ${API_SECRET}`,
  };

  const res = await fetchWithTimeout(
    WORKER_WEBHOOK_URL,
    { method: "POST", headers, body: JSON.stringify(body) },
    JOB_TIMEOUT_MS
  );

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, code: `webhook_failed_http_${res.status}`, detail: text };
  }

  return { ok: true, code: "ok", detail: text };
}

// ---------- main loop ----------
let lastAuditAt = 0;

async function loop() {
  while (true) {
    try {
      log({ tag: TAG, msg: "POLL", ts: nowIso(), types: TYPES });

      // audit every ~10 seconds to prove what’s in the DB
      if (nowMs() - lastAuditAt > 10000) {
        lastAuditAt = nowMs();
        await queueAudit(TYPES);
      }

      const candidate = await pickQueuedJob(TYPES);
      if (!candidate) {
        await sleep(POLL_MS);
        continue;
      }

      const claimed = await claimJob(candidate.id);
      if (!claimed) {
        await sleep(250);
        continue;
      }

      log({
        tag: TAG,
        msg: "JOB_CLAIMED",
        ts: nowIso(),
        id: claimed.id,
        type: claimed.type,
        claimed_by: claimed.claimed_by,
        run_at: claimed.run_at || null,
      });

      const result = await executeViaWebhook(claimed);

      if (result.ok) {
        await completeJob(claimed.id);
        log({ tag: TAG, msg: "JOB_COMPLETED", ts: nowIso(), id: claimed.id, type: claimed.type });
      } else {
        await failJob(claimed.id, result.code, result.detail);
        log({
          tag: TAG,
          msg: "JOB_FAILED",
          ts: nowIso(),
          id: claimed.id,
          type: claimed.type,
          last_error: result.code,
          detail: safeTrim(result.detail).slice(0, 300),
        });
      }

      await sleep(250);
    } catch (err) {
      log({
        tag: TAG,
        msg: "LOOP_ERROR",
        ts: nowIso(),
        error: String(err && err.message ? err.message : err),
      });
      await sleep(Math.max(1000, POLL_MS));
    }
  }
}

loop();
