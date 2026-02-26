/**
 * worker.js (CommonJS)
 * Production-safe execution worker for Railway + Supabase.
 *
 * Core job:
 *  - claim execution_jobs(status='queued') and POST to WORKER_WEBHOOK_URL
 *
 * Self-heal:
 *  - If queue is empty, requeue "deadletter_max_attempts" exit jobs
 *    ONLY when their trade is still open (paper mode).
 *
 * Optional emergency mode (OFF by default):
 *  - ENQUEUE_FROM_APPROVED=1
 *    Backfill missing execution_jobs from execution_intents(status='approved')
 *
 * Env vars expected:
 *  - SUPABASE_URL
 *  - SUPABASE_SERVICE_KEY
 *  - WORKER_ENABLED
 *  - WORKER_ID
 *  - TYPES
 *  - POLL_MS
 *  - HEARTBEAT_SECS
 *  - JOB_TIMEOUT_MS
 *  - WORKER_WEBHOOK_URL
 *  - API_SECRET
 *
 * Optional:
 *  - MAX_ATTEMPTS (default 3)          // per-job attempts inside worker (not DB attempts)
 *  - RETRY_BACKOFF_MS (default 5000)
 *  - ENQUEUE_FROM_APPROVED (default 0)
 *  - ENQUEUE_BATCH (default 25)
 *  - SELFHEAL_DEADLETTER (default 1)
 *  - SELFHEAL_BATCH (default 25)
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
function safeTrim(v) {
  return String(v || "").trim();
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
function jget(obj, path, fallback = null) {
  try {
    let cur = obj;
    for (const k of path) {
      if (cur == null) return fallback;
      cur = cur[k];
    }
    return cur == null ? fallback : cur;
  } catch {
    return fallback;
  }
}

// ---------- config ----------
const TAG = "AUX";
const WORKER_ENABLED = envBool("WORKER_ENABLED", true);
const WORKER_ID = process.env.WORKER_ID || "ladder-worker-1";
const TYPES = parseTypes(process.env.TYPES || process.env.WORKER_TYPES || "execute_intent");
const POLL_MS = envInt("POLL_MS", 2000);
const HEARTBEAT_SECS = envInt("HEARTBEAT_SECS", 20);
const JOB_TIMEOUT_MS = envInt("JOB_TIMEOUT_MS", 60000);

const MAX_ATTEMPTS = envInt("MAX_ATTEMPTS", 3);
const RETRY_BACKOFF_MS = envInt("RETRY_BACKOFF_MS", 5000);

const ENQUEUE_FROM_APPROVED = envBool("ENQUEUE_FROM_APPROVED", false);
const ENQUEUE_BATCH = envInt("ENQUEUE_BATCH", 25);

const SELFHEAL_DEADLETTER = envBool("SELFHEAL_DEADLETTER", true);
const SELFHEAL_BATCH = envInt("SELFHEAL_BATCH", 25);

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const WORKER_WEBHOOK_URL = normalizeWebhookUrl(process.env.WORKER_WEBHOOK_URL || process.env.WEBHOOK_URL || "");
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
  SELFHEAL_DEADLETTER,
  SELFHEAL_BATCH,
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
    msg: "WARN_MISSING_WEBHOOK_URL",
    ts: nowIso(),
    hint: "Set WORKER_WEBHOOK_URL to ladder-bot executor endpoint (usually https://.../webhook/worker)",
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

// ---------- supabase client ----------
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------- core DB ops ----------
async function pickQueuedJob(types) {
  const { data, error } = await sb
    .from("execution_jobs")
    .select("id,type,status,payload,attempts,created_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id")
    .in("type", types)
    .eq("status", "queued")
    .is("claimed_by", null)
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
    .is("claimed_by", null)
    .select("id,type,status,payload,attempts,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id")
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

async function failJob(jobId, lastErrorCode) {
  const now = nowIso();
  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "failed",
      heartbeat_at: now,
      last_step: "failed",
      last_error: lastErrorCode || "unknown_error",
    })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID);

  if (error) throw error;
}

// ---------- webhook execution ----------
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

  const headers = { "content-type": "application/json" };
  if (hasApiSecret) {
    headers["x-api-secret"] = API_SECRET;
    headers["x-api-key"] = API_SECRET;
    headers["authorization"] = `Bearer ${API_SECRET}`;
  }

  const res = await fetchWithTimeout(
    WORKER_WEBHOOK_URL,
    { method: "POST", headers, body: JSON.stringify(body) },
    JOB_TIMEOUT_MS
  );

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, code: `webhook_failed_http_${res.status}`, detail: text.slice(0, 500) };
  }
  return { ok: true, code: "ok", detail: text.slice(0, 500) };
}

// ---------- queue audit (lightweight) ----------
async function queueAudit() {
  async function countJobsByStatus(status) {
    const { count, error } = await sb.from("execution_jobs").select("id", { count: "exact", head: true }).eq("status", status);
    if (error) throw error;
    return count || 0;
  }
  async function countIntentsByStatus(status) {
    const { count, error } = await sb.from("execution_intents").select("id", { count: "exact", head: true }).eq("status", status);
    if (error) throw error;
    return count || 0;
  }

  const statusCounts = {
    queued: await countJobsByStatus("queued"),
    running: await countJobsByStatus("running"),
    completed: await countJobsByStatus("completed"),
    failed: await countJobsByStatus("failed"),
    archived: await countJobsByStatus("archived"),
    cancelled: await countJobsByStatus("cancelled"),
  };

  const { count: queuedForTypes, error: e2 } = await sb
    .from("execution_jobs")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued")
    .is("claimed_by", null)
    .in("type", TYPES);
  if (e2) throw e2;

  const pendingIntents = await countIntentsByStatus("pending");
  const approvedIntents = await countIntentsByStatus("approved");

  const { data: oldest, error: e3 } = await sb
    .from("execution_jobs")
    .select("run_at")
    .eq("status", "queued")
    .order("run_at", { ascending: true })
    .limit(1);
  if (e3) throw e3;

  const { data: recentJobs, error: e4 } = await sb
    .from("execution_jobs")
    .select("id,intent_id,type,status,claimed_by,run_at,created_at,attempts,last_step,last_error")
    .order("created_at", { ascending: false })
    .limit(5);
  if (e4) throw e4;

  log({
    tag: TAG,
    msg: "QUEUE_AUDIT",
    ts: nowIso(),
    types: TYPES,
    statusCounts,
    queuedForTypes: queuedForTypes || 0,
    pendingIntents,
    approvedIntents,
    oldest_run_at: oldest && oldest[0] ? oldest[0].run_at : null,
    recentJobs: (recentJobs || []).map((j) => ({
      id: j.id,
      intent_id: j.intent_id,
      type: j.type,
      status: j.status,
      claimed_by: j.claimed_by,
      run_at: j.run_at,
      created_at: j.created_at,
      attempts: j.attempts,
      last_step: j.last_step,
      last_error: j.last_error,
    })),
  });

  return statusCounts;
}

// ---------- emergency: enqueue jobs from approved intents (missing runnable job) ----------
async function enqueueFromApproved(maxBatch) {
  if (!ENQUEUE_FROM_APPROVED) return 0;

  // Pull approved intents (include raw_signal so we can derive trade_id safely)
  const { data: intents, error: e1 } = await sb
    .from("execution_intents")
    .select("id,action,symbol,execution_mode,created_at,raw_signal")
    .eq("status", "approved")
    .order("created_at", { ascending: true })
    .limit(maxBatch);
  if (e1) throw e1;
  if (!intents || intents.length === 0) return 0;

  const intentIds = intents.map((x) => x.id);

  // Find intents that already have a runnable job (queued or running)
  const { data: runnable, error: e2 } = await sb
    .from("execution_jobs")
    .select("intent_id,status")
    .in("intent_id", intentIds)
    .in("status", ["queued", "running"]);
  if (e2) throw e2;

  const runnableSet = new Set((runnable || []).map((x) => x.intent_id));
  const missing = intents.filter((i) => !runnableSet.has(i.id));
  if (missing.length === 0) {
    log({
      tag: TAG,
      msg: "ENQUEUE_DEBUG",
      ts: nowIso(),
      approved_batch: intents.length,
      runnable_jobs_found: runnableSet.size,
      missing_jobs: 0,
      inserted: 0,
      note: "All approved intents already have runnable execution_jobs (queued/running).",
    });
    return 0;
  }

  const now = nowIso();
  const rows = missing.map((i) => {
    const tradeId = (i.raw_signal && (i.raw_signal.trade_id || i.raw_signal["trade_id"])) || null;
    return {
      created_at: now,
      run_at: now,
      intent_id: i.id,
      type: "execute_intent",
      payload: {
        intent_id: i.id,
        action: i.action,
        symbol: i.symbol,
        execution_mode: i.execution_mode || "paper",
        trade_id: tradeId,
        created_from: "worker_enqueue_from_approved_missing_runnable",
      },
      status: "queued",
      attempts: 0,
      last_error: null,
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: null,
      run_id: null,
      last_step: "enqueued_by_worker",
    };
  });

  const { error: e3 } = await sb.from("execution_jobs").insert(rows);
  if (e3) throw e3;

  log({
    tag: TAG,
    msg: "ENQUEUE_FROM_APPROVED",
    ts: nowIso(),
    approved_batch: intents.length,
    missing_runnable: missing.length,
    inserted: rows.length,
  });

  return rows.length;
}

// ---------- selfheal: requeue deadletter exits when trade still open ----------
async function tradeIsOpen(tradeId) {
  if (!tradeId) return null;

  const { data, error } = await sb
    .from("trades_prod")
    .select("id,status")
    .eq("id", tradeId)
    .limit(1);

  if (error) throw error;
  if (!data || !data[0]) return null;
  return String(data[0].status || "").toLowerCase() === "open";
}

function isExitAction(action) {
  const a = String(action || "").toLowerCase();
  return a === "close" || a === "exit" || a === "sell";
}

async function requeueDeadletter(maxBatch) {
  if (!SELFHEAL_DEADLETTER) return 0;

  // Find deadlettered jobs (failed with deadletter_max_attempts)
  const { data: dead, error: e1 } = await sb
    .from("execution_jobs")
    .select("id,intent_id,type,status,payload,created_at,run_at,last_error,last_step")
    .eq("type", "execute_intent")
    .eq("status", "failed")
    .eq("last_error", "deadletter_max_attempts")
    .order("created_at", { ascending: true })
    .limit(maxBatch);
  if (e1) throw e1;
  if (!dead || dead.length === 0) return 0;

  // Pull corresponding intents to get raw_signal for trade_id if missing in payload
  const intentIds = dead.map((j) => j.intent_id).filter(Boolean);
  const { data: intents, error: e2 } = await sb
    .from("execution_intents")
    .select("id,action,symbol,execution_mode,raw_signal")
    .in("id", intentIds);
  if (e2) throw e2;

  const intentMap = new Map((intents || []).map((i) => [i.id, i]));

  let inserted = 0;
  for (const j of dead) {
    const intent = intentMap.get(j.intent_id) || null;

    const action = jget(j, ["payload", "action"], null) || (intent ? intent.action : null);
    const symbol = jget(j, ["payload", "symbol"], null) || (intent ? intent.symbol : null);

    if (!isExitAction(action)) {
      log({ tag: TAG, msg: "SELFHEAL_SKIP_NOT_EXIT", ts: nowIso(), job_id: j.id, intent_id: j.intent_id, action });
      continue;
    }

    const tradeIdFromPayload = jget(j, ["payload", "trade_id"], null);
    const tradeIdFromIntent = intent && intent.raw_signal ? (intent.raw_signal.trade_id || intent.raw_signal["trade_id"]) : null;
    const tradeId = tradeIdFromPayload || tradeIdFromIntent;

    const open = await tradeIsOpen(tradeId);
    if (open !== true) {
      log({
        tag: TAG,
        msg: "SELFHEAL_SKIP_TRADE_NOT_OPEN",
        ts: nowIso(),
        job_id: j.id,
        intent_id: j.intent_id,
        trade_id: tradeId,
        trade_open: open,
      });
      continue;
    }

    // Requeue as a NEW job row (safe, immutable history)
    const now = nowIso();
    const row = {
      created_at: now,
      run_at: now,
      intent_id: j.intent_id,
      type: "execute_intent",
      payload: {
        intent_id: j.intent_id,
        action,
        symbol,
        execution_mode: (intent && intent.execution_mode) || jget(j, ["payload", "execution_mode"], "paper") || "paper",
        trade_id: tradeId,
        created_from: "worker_selfheal_requeue_deadletter_open_trade",
        prev_job_id: j.id,
      },
      status: "queued",
      attempts: 0,
      last_error: null,
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: null,
      run_id: null,
      last_step: "selfheal_requeued",
    };

    const { error: e3 } = await sb.from("execution_jobs").insert([row]);
    if (e3) {
      log({ tag: TAG, msg: "SELFHEAL_INSERT_ERROR", ts: nowIso(), job_id: j.id, error: String(e3.message || e3) });
      continue;
    }

    inserted += 1;
    log({
      tag: TAG,
      msg: "SELFHEAL_REQUEUED",
      ts: nowIso(),
      prev_job_id: j.id,
      intent_id: j.intent_id,
      trade_id: tradeId,
      action,
      symbol,
    });
  }

  return inserted;
}

// ---------- main loop ----------
let lastAuditAt = 0;
let inFlightAttempts = new Map(); // job_id -> n attempts in this process

async function loop() {
  while (true) {
    try {
      log({ tag: TAG, msg: "POLL", ts: nowIso(), types: TYPES });

      const nowMs = Date.now();
      if (nowMs - lastAuditAt > 15000) {
        lastAuditAt = nowMs;
        await queueAudit();
      }

      // Backfill missing runnable jobs from approved intents (optional)
      await enqueueFromApproved(ENQUEUE_BATCH);

      // If nothing queued, selfheal deadletter exits (safe)
      // (This is the part that was crashing before because of execution_intents.trade_id)
      await requeueDeadletter(SELFHEAL_BATCH);

      const candidate = await pickQueuedJob(TYPES);
      if (!candidate) {
        log({
          tag: TAG,
          msg: "PICK_DEBUG",
          ts: nowIso(),
          queued_total_for_types: 0,
          unclaimed_runnable_now: 0,
          oldest_run_at: null,
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
        intent_id: claimed.intent_id,
        claimed_by: claimed.claimed_by,
        last_step: claimed.last_step,
      });

      const result = await executeViaWebhook(claimed);

      if (result.ok) {
        await completeJob(claimed.id);
        inFlightAttempts.delete(claimed.id);
        log({ tag: TAG, msg: "JOB_COMPLETED", ts: nowIso(), id: claimed.id, type: claimed.type });
      } else {
        // retry a few times inside worker process before marking failed
        const n = (inFlightAttempts.get(claimed.id) || 0) + 1;
        inFlightAttempts.set(claimed.id, n);

        if (n < MAX_ATTEMPTS) {
          // put back to queued for retry
          const now = nowIso();
          const { error } = await sb
            .from("execution_jobs")
            .update({
              status: "queued",
              claimed_by: null,
              claimed_at: null,
              heartbeat_at: now,
              last_step: `retry_${n}`,
              last_error: result.code,
              run_at: now,
            })
            .eq("id", claimed.id)
            .eq("claimed_by", WORKER_ID);
          if (error) throw error;

          log({
            tag: TAG,
            msg: "JOB_RETRY_QUEUED",
            ts: nowIso(),
            id: claimed.id,
            attempt: n,
            last_error: result.code,
            detail: result.detail,
          });

          await sleep(RETRY_BACKOFF_MS);
        } else {
          await failJob(claimed.id, result.code);
          inFlightAttempts.delete(claimed.id);
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
