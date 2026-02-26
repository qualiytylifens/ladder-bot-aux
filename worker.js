/**
 * worker.js (CommonJS)
 * Production-safe execution worker for Railway (Supabase-backed job queue).
 *
 * Purpose:
 *  - Polls execution_jobs for runnable queued jobs (by type)
 *  - Claims → POSTs to ladder-bot worker webhook → completes or fails job
 *  - Prints HARD diagnostics (QUEUE_AUDIT + PICK_DEBUG) so we never guess again
 *
 * Env vars expected (Railway):
 *  - SUPABASE_URL
 *  - SUPABASE_SERVICE_KEY
 *  - WORKER_ENABLED           (1/0 or true/false)
 *  - WORKER_ID               (e.g. ladder-worker-1)
 *  - TYPES or WORKER_TYPES   (default: execute_intent)
 *  - POLL_MS                 (default: 2000)
 *  - HEARTBEAT_SECS          (default: 20)
 *  - JOB_TIMEOUT_MS          (default: 60000)
 *  - MAX_ATTEMPTS            (default: 3)
 *  - RETRY_BACKOFF_MS        (default: 5000)
 *  - WORKER_WEBHOOK_URL      (full endpoint, e.g. https://ladder-bot.../webhook/worker)
 *  - API_SECRET              (must match ladder-bot API_SECRET)
 */

const { createClient } = require("@supabase/supabase-js");
const { URL } = require("url");

// ---------------- helpers ----------------
function nowIso() {
  return new Date().toISOString();
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

  // JSON array form
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr.length) return arr.map(String);
    } catch {}
  }

  // Comma/space separated form
  const out = s
    .split(/[,\s]+/g)
    .map((x) => x.trim())
    .filter(Boolean);

  return out.length ? out : ["execute_intent"];
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function normalizeWebhookUrl(u) {
  return safeTrim(u);
}

function hostOf(maybeUrl) {
  try {
    return new URL(maybeUrl).host;
  } catch {
    return null;
  }
}

function prefixOfUrl(maybeUrl) {
  try {
    const u = new URL(maybeUrl);
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 48) + (u.pathname.length > 20 ? "..." : "");
  } catch {
    return null;
  }
}

// ---------------- config ----------------
const TAG = "AUX";

const WORKER_ENABLED = envBool("WORKER_ENABLED", true);
const WORKER_ID = safeTrim(process.env.WORKER_ID || "ladder-worker-1");

// Prefer WORKER_TYPES if set, else TYPES
const TYPES = parseTypes(process.env.WORKER_TYPES || process.env.TYPES || "execute_intent");

const POLL_MS = envInt("POLL_MS", 2000);
const HEARTBEAT_SECS = envInt("HEARTBEAT_SECS", 20);
const JOB_TIMEOUT_MS = envInt("JOB_TIMEOUT_MS", 60000);

const MAX_ATTEMPTS = envInt("MAX_ATTEMPTS", 3);
const RETRY_BACKOFF_MS = envInt("RETRY_BACKOFF_MS", 5000);

const SUPABASE_URL = safeTrim(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_KEY = safeTrim(process.env.SUPABASE_SERVICE_KEY || "");

const WORKER_WEBHOOK_URL = normalizeWebhookUrl(process.env.WORKER_WEBHOOK_URL || process.env.WEBHOOK_URL || "");
const API_SECRET = safeTrim(process.env.API_SECRET || "");

const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const hasWebhook = Boolean(WORKER_WEBHOOK_URL);
const hasApiSecret = Boolean(API_SECRET);

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
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  hasSupabase,
  hasWebhook,
  hasApiSecret,
  supabase_host: hostOf(SUPABASE_URL),
  webhook_host: hostOf(WORKER_WEBHOOK_URL),
  webhook_url_prefix: prefixOfUrl(WORKER_WEBHOOK_URL),
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
    msg: "WARN_MISSING_WEBHOOK_URL",
    ts: nowIso(),
    hint: "Set WORKER_WEBHOOK_URL to ladder-bot worker endpoint (full path, e.g. /webhook/worker)",
  });
}

if (hasWebhook && !hasApiSecret) {
  log({
    tag: TAG,
    msg: "WARN_MISSING_API_SECRET",
    ts: nowIso(),
    hint: "Set API_SECRET (must match ladder-bot API_SECRET) to avoid webhook_failed_http_401",
  });
}

// ---------------- supabase client ----------------
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------------- diagnostics (NO GUESSING) ----------------
let lastAuditAt = 0;
const AUDIT_EVERY_MS = 10_000;

async function queueAudit(types) {
  // Count jobs by status (fast + reliable with head:true)
  const statuses = ["queued", "running", "completed", "failed", "archived", "cancelled"];
  const statusCounts = {};
  for (const st of statuses) {
    const { count, error } = await sb
      .from("execution_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", st);
    if (error) throw error;
    statusCounts[st] = count ?? null;
  }

  // Count queued jobs for our TYPES
  const { count: queuedForTypes, error: eQueuedTypes } = await sb
    .from("execution_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued")
    .is("claimed_by", null)
    .in("type", types);
  if (eQueuedTypes) throw eQueuedTypes;

  // Recent jobs (last 10)
  const { data: recentJobs, error: eRecent } = await sb
    .from("execution_jobs")
    .select("id,type,status,claimed_by,run_at,created_at,last_error,last_step,attempts")
    .order("created_at", { ascending: false })
    .limit(10);
  if (eRecent) throw eRecent;

  // Intents visibility (helps prove upstream enqueue)
  let pendingIntents = null;
  let approvedIntents = null;
  try {
    const a = await sb.from("execution_intents").select("id", { count: "exact", head: true }).eq("status", "pending");
    if (!a.error) pendingIntents = a.count ?? null;

    const b = await sb.from("execution_intents").select("id", { count: "exact", head: true }).eq("status", "approved");
    if (!b.error) approvedIntents = b.count ?? null;
  } catch {}

  // Oldest runnable run_at (queued/unclaimed for our types)
  let oldestRunAt = null;
  try {
    const { data } = await sb
      .from("execution_jobs")
      .select("run_at")
      .eq("status", "queued")
      .is("claimed_by", null)
      .in("type", types)
      .order("run_at", { ascending: true, nullsFirst: true })
      .limit(1);
    if (data && data[0]) oldestRunAt = data[0].run_at ?? null;
  } catch {}

  log({
    tag: TAG,
    msg: "QUEUE_AUDIT",
    ts: nowIso(),
    types,
    statusCounts,
    queuedForTypes: queuedForTypes ?? null,
    pendingIntents,
    approvedIntents,
    oldest_run_at: oldestRunAt,
    recentJobs: (recentJobs || []).map((j) => ({
      id: j.id,
      type: j.type,
      status: j.status,
      claimed_by: j.claimed_by,
      run_at: j.run_at,
      created_at: j.created_at,
      attempts: j.attempts,
      last_step: j.last_step,
      last_error: j.last_error ? String(j.last_error).slice(0, 120) : null,
    })),
  });
}

// ---------------- core DB ops ----------------
function isRunnable(job) {
  // runnable if run_at is null OR run_at <= now
  if (!job) return false;
  if (!job.run_at) return true;
  const t = Date.parse(job.run_at);
  if (!Number.isFinite(t)) return true;
  return t <= Date.now();
}

async function pickQueuedJob(types) {
  // Fetch a small window, then pick first runnable locally.
  // This avoids SQL operator issues on run_at and keeps it compatible across schemas.
  const { data, error } = await sb
    .from("execution_jobs")
    .select("id,type,status,payload,attempts,created_at,run_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error")
    .in("type", types)
    .eq("status", "queued")
    .is("claimed_by", null)
    .order("run_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(25);

  if (error) throw error;

  const list = Array.isArray(data) ? data : [];
  const runnable = list.find(isRunnable) || null;

  // PICK_DEBUG exactly like your logs
  log({
    tag: TAG,
    msg: "PICK_DEBUG",
    ts: nowIso(),
    queued_seen: list.length,
    oldest_run_at: list.length ? (list[0].run_at ?? null) : null,
    runnable_found: Boolean(runnable),
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
    .select("id,type,status,payload,attempts,created_at,run_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error")
    .limit(1);

  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function touchHeartbeat(jobId) {
  const now = nowIso();
  const { error } = await sb
    .from("execution_jobs")
    .update({
      heartbeat_at: now,
      last_step: "heartbeat",
    })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID)
    .in("status", ["running"]);
  if (error) throw error;
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

async function failJob(jobId, lastErrorCode) {
  const now = nowIso();

  // Get current attempts so we can decide retry/failed
  const { data: cur, error: eCur } = await sb
    .from("execution_jobs")
    .select("id,attempts")
    .eq("id", jobId)
    .limit(1);
  if (eCur) throw eCur;

  const attempts = (cur && cur[0] && Number.isFinite(cur[0].attempts)) ? cur[0].attempts : 0;
  const nextAttempts = attempts + 1;

  const shouldRetry = nextAttempts < MAX_ATTEMPTS;

  const patch = {
    attempts: nextAttempts,
    heartbeat_at: now,
    last_step: shouldRetry ? "retry_scheduled" : "failed",
    last_error: lastErrorCode || "unknown_error",
    status: shouldRetry ? "queued" : "failed",
    claimed_by: shouldRetry ? null : WORKER_ID,
    claimed_at: shouldRetry ? null : now,
  };

  if (shouldRetry) {
    // backoff
    patch.run_at = new Date(Date.now() + RETRY_BACKOFF_MS).toISOString();
  }

  const { error } = await sb.from("execution_jobs").update(patch).eq("id", jobId);

  if (error) throw error;
}

// ---------------- webhook execution ----------------
async function executeViaWebhook(job) {
  if (!hasWebhook) {
    return { ok: false, code: "missing_webhook_url", detail: "WORKER_WEBHOOK_URL not set" };
  }

  const body = {
    job_id: job.id,
    type: job.type,
    payload: job.payload || {},
    worker_id: WORKER_ID,
    ts: nowIso(),
  };

  const headers = {
    "content-type": "application/json",
  };

  if (hasApiSecret) {
    headers["x-api-secret"] = API_SECRET;
    headers["x-api-key"] = API_SECRET;
    headers["authorization"] = `Bearer ${API_SECRET}`;
  }

  // Heartbeat timer
  let hb = null;
  try {
    hb = setInterval(() => {
      touchHeartbeat(job.id).catch(() => {});
    }, Math.max(5000, HEARTBEAT_SECS * 1000));
  } catch {}

  try {
    const res = await fetchWithTimeout(
      WORKER_WEBHOOK_URL,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      JOB_TIMEOUT_MS
    );

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return {
        ok: false,
        code: `webhook_failed_http_${res.status}`,
        detail: text.slice(0, 500),
      };
    }

    return { ok: true, code: "ok", detail: text.slice(0, 500) };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    return { ok: false, code: "webhook_failed_exception", detail: msg.slice(0, 500) };
  } finally {
    if (hb) clearInterval(hb);
  }
}

// ---------------- main loop ----------------
async function loop() {
  while (true) {
    try {
      log({ tag: TAG, msg: "POLL", ts: nowIso(), types: TYPES });

      // periodic deep audit
      const now = Date.now();
      if (now - lastAuditAt > AUDIT_EVERY_MS) {
        lastAuditAt = now;
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
        last_step: claimed.last_step,
      });

      const result = await executeViaWebhook(claimed);

      if (result.ok) {
        await completeJob(claimed.id);
        log({ tag: TAG, msg: "JOB_COMPLETED", ts: nowIso(), id: claimed.id, type: claimed.type });
      } else {
        await failJob(claimed.id, result.code);
        log({
          tag: TAG,
          msg: "JOB_FAILED",
          ts: nowIso(),
          id: claimed.id,
          type: claimed.type,
          last_error: result.code,
          detail: result.detail,
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
