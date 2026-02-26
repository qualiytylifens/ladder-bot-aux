/**
 * worker.js (CommonJS)
 * Institutional-grade execution worker for Railway + Supabase.
 *
 * Core job:
 *  - Claim execution_jobs(status='queued') that are runnable now
 *  - POST to executor webhook
 *  - Treat non-200 as fail
 *  - ALSO treat 200 responses that contain executor-side failure signals as fail
 *
 * This file is for ladder-worker (NOT ladder-bot).
 */

const { createClient } = require("@supabase/supabase-js");

// ---------- helpers ----------
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
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr.length) return arr.map(String);
    } catch {}
  }
  return s
    .split(/[,\s]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}
function normalizeWebhookUrl(u) {
  return safeTrim(u);
}
function hostFromUrl(u) {
  try {
    return new URL(u).host;
  } catch {
    return null;
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
function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---------- config ----------
const TAG = "AUX";

const WORKER_ENABLED = envBool("WORKER_ENABLED", true);
const WORKER_ID = safeTrim(process.env.WORKER_ID) || "ladder-worker-1";

// Support TYPES + WORKER_TYPES
const TYPES = parseTypes(process.env.WORKER_TYPES || process.env.TYPES || "execute_intent");

const POLL_MS = envInt("POLL_MS", 2000);
const HEARTBEAT_SECS = envInt("HEARTBEAT_SECS", 20);
const JOB_TIMEOUT_MS = envInt("JOB_TIMEOUT_MS", 60000);

// Optional emergency mode (OFF by default)
const ENQUEUE_FROM_APPROVED = envBool("ENQUEUE_FROM_APPROVED", false);
const ENQUEUE_BATCH = envInt("ENQUEUE_BATCH", 25);

// Retries
const MAX_ATTEMPTS = envInt("MAX_ATTEMPTS", 3);
const RETRY_BACKOFF_MS = envInt("RETRY_BACKOFF_MS", 5000);

const SUPABASE_URL = safeTrim(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_KEY = safeTrim(process.env.SUPABASE_SERVICE_KEY || "");

// Webhook URL compatibility (use the most explicit first)
const WORKER_WEBHOOK_URL = normalizeWebhookUrl(
  process.env.WORKER_WEBHOOK_URL ||
    process.env.WEBHOOK_URL ||
    process.env.BOT_WEBHOOK_URL ||
    ""
);

const API_SECRET = safeTrim(process.env.API_SECRET || "");

const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const hasWebhook = Boolean(WORKER_WEBHOOK_URL);
const hasApiSecret = Boolean(API_SECRET);

const supabaseHost = hostFromUrl(SUPABASE_URL);
const webhookHost = hostFromUrl(WORKER_WEBHOOK_URL);

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
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  ENQUEUE_FROM_APPROVED,
  ENQUEUE_BATCH,
  hasSupabase,
  hasWebhook,
  hasApiSecret,
  supabase_host: supabaseHost,
  webhook_host: webhookHost,
  webhook_url_prefix: WORKER_WEBHOOK_URL ? WORKER_WEBHOOK_URL.slice(0, 60) : null,
});

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
    hint: "Set WORKER_WEBHOOK_URL to ladder-bot executor endpoint, e.g. https://<ladder-bot>/webhook/worker",
  });
  process.exit(1);
}
if (!hasApiSecret) {
  log({
    tag: TAG,
    msg: "FATAL_MISSING_API_SECRET",
    ts: nowIso(),
    hint: "Set API_SECRET (must match ladder-bot API_SECRET) to avoid auth failures",
  });
  process.exit(1);
}

// ---------- supabase client ----------
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------- emergency: enqueue jobs from approved intents ----------
async function enqueueFromApproved(maxBatch) {
  if (!ENQUEUE_FROM_APPROVED) return 0;

  const { data: intents, error: e1 } = await sb
    .from("execution_intents")
    .select("id,action,symbol,execution_mode,created_at")
    .eq("status", "approved")
    .order("created_at", { ascending: true })
    .limit(maxBatch);

  if (e1) throw e1;
  if (!intents || intents.length === 0) return 0;

  const intentIds = intents.map((x) => x.id);

  const { data: existing, error: e2 } = await sb
    .from("execution_jobs")
    .select("intent_id")
    .in("intent_id", intentIds);
  if (e2) throw e2;

  const existingSet = new Set((existing || []).map((x) => x.intent_id));
  const missing = intents.filter((i) => !existingSet.has(i.id));
  if (missing.length === 0) return 0;

  const now = nowIso();
  const rows = missing.map((i) => ({
    run_at: now,
    intent_id: i.id,
    type: "execute_intent",
    payload: {
      intent_id: i.id,
      action: i.action,
      symbol: i.symbol,
      execution_mode: i.execution_mode || "paper",
      created_from: "worker_enqueue_from_approved",
    },
    status: "queued",
    attempts: 0,
    last_error: null,
    claimed_by: null,
    claimed_at: null,
    heartbeat_at: null,
    run_id: null,
    last_step: "enqueued_by_worker",
  }));

  const { error: e3 } = await sb.from("execution_jobs").insert(rows);
  if (e3) throw e3;

  log({
    tag: TAG,
    msg: "ENQUEUE_FROM_APPROVED",
    ts: nowIso(),
    requested: intents.length,
    missing: missing.length,
    inserted: rows.length,
  });

  return rows.length;
}

// ---------- core DB ops ----------
// IMPORTANT: include BOTH claimed_by IS NULL and claimed_by = ''
// IMPORTANT: include run_at <= now (or run_at is null)
async function pickQueuedJob(types) {
  const now = nowIso();

  const { data, error } = await sb
    .from("execution_jobs")
    .select("id,type,status,payload,attempts,created_at,run_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error")
    .in("type", types)
    .eq("status", "queued")
    .or("claimed_by.is.null,claimed_by.eq.")
    .or(`run_at.is.null,run_at.lte.${now}`)
    .order("run_at", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) throw error;
  return data && data[0] ? data[0] : null;
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
    .or("claimed_by.is.null,claimed_by.eq.")
    .select("id,type,status,payload,attempts,created_at,run_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error")
    .limit(1);

  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function setHeartbeat(jobId) {
  const now = nowIso();
  const { error } = await sb
    .from("execution_jobs")
    .update({ heartbeat_at: now, last_step: "heartbeat" })
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
      last_error: null,
    })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID);

  if (error) throw error;
}

async function requeueJob(jobId, attempts, lastErrorCode) {
  const now = nowIso();
  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "queued",
      attempts: attempts,
      last_error: lastErrorCode || "unknown_error",
      last_step: "requeued",
      heartbeat_at: now,
      claimed_by: null,
      claimed_at: null,
      run_at: new Date(Date.now() + RETRY_BACKOFF_MS).toISOString(),
    })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID);

  if (error) throw error;
}

async function failJob(jobId, attempts, lastErrorCode) {
  const now = nowIso();
  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "failed",
      attempts: attempts,
      heartbeat_at: now,
      last_step: "failed",
      last_error: lastErrorCode || "unknown_error",
    })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID);

  if (error) throw error;
}

// ---------- webhook execution ----------
// Treat HTTP 200 with "soft fail" body as a FAIL.
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

  const hbInterval = setInterval(() => {
    setHeartbeat(job.id).catch(() => {});
  }, Math.max(2000, HEARTBEAT_SECS * 1000));

  try {
    const res = await fetchWithTimeout(
      WORKER_WEBHOOK_URL,
      { method: "POST", headers, body: JSON.stringify(body) },
      JOB_TIMEOUT_MS
    );

    const text = await res.text().catch(() => "");
    const json = tryParseJson(text);

    if (!res.ok) {
      return {
        ok: false,
        code: `webhook_failed_http_${res.status}`,
        detail: text.slice(0, 500),
      };
    }

    // soft-fail detection (HTTP 200 but executor says it failed)
    const hay = (text || "").toLowerCase();
    const softFail =
      hay.includes("postcheck_trade_still_open") ||
      hay.includes("trade still open") ||
      hay.includes("exit webhook returned 200 but trade still open") ||
      (json && (json.ok === false || json.success === false || json.error || json.error_code));

    if (softFail) {
      const code =
        (json && (json.error_code || json.code)) ||
        (hay.includes("postcheck_trade_still_open") || hay.includes("trade still open")
          ? "postcheck_trade_still_open"
          : "executor_soft_fail");

      return {
        ok: false,
        code,
        detail: (json ? JSON.stringify(json).slice(0, 500) : text.slice(0, 500)),
      };
    }

    return { ok: true, code: "ok", detail: text.slice(0, 500) };
  } finally {
    clearInterval(hbInterval);
  }
}

// ---------- main loop ----------
async function loop() {
  while (true) {
    try {
      log({ tag: TAG, msg: "POLL", ts: nowIso(), types: TYPES });

      // Optional emergency backfill
      await enqueueFromApproved(ENQUEUE_BATCH);

      const candidate = await pickQueuedJob(TYPES);

      if (!candidate) {
        log({
          tag: TAG,
          msg: "PICK_DEBUG",
          ts: nowIso(),
          queued_seen: 0,
          runnable_found: false,
        });
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
        attempts: claimed.attempts || 0,
        claimed_by: claimed.claimed_by,
      });

      const attemptsNext = (claimed.attempts || 0) + 1;
      const result = await executeViaWebhook(claimed);

      if (result.ok) {
        await completeJob(claimed.id);
        log({ tag: TAG, msg: "JOB_COMPLETED", ts: nowIso(), id: claimed.id, type: claimed.type });
      } else {
        if (attemptsNext < MAX_ATTEMPTS) {
          await requeueJob(claimed.id, attemptsNext, result.code);
          log({
            tag: TAG,
            msg: "JOB_REQUEUED",
            ts: nowIso(),
            id: claimed.id,
            type: claimed.type,
            attempts: attemptsNext,
            last_error: result.code,
            detail: result.detail,
          });
        } else {
          await failJob(claimed.id, attemptsNext, result.code);
          log({
            tag: TAG,
            msg: "JOB_FAILED",
            ts: nowIso(),
            id: claimed.id,
            type: claimed.type,
            attempts: attemptsNext,
            last_error: result.code,
            detail: result.detail,
          });
        }
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
