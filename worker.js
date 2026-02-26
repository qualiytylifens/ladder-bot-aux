/**
 * worker.js (CommonJS)
 * Production-safe execution worker for Railway + Supabase.
 *
 * Core job:
 *  - claim execution_jobs(status='queued') where:
 *      - claimed_by is null
 *      - run_at is null OR run_at <= now()
 *  - POST to WORKER_WEBHOOK_URL (ladder-bot /webhook/worker) with API_SECRET auth
 *
 * Retry:
 *  - Uses execution_jobs.attempts (persisted in DB)
 *  - On failure: increments attempts, requeues with backoff by setting run_at in the future
 *  - When attempts reaches MAX_ATTEMPTS: marks failed with last_error=deadletter_max_attempts
 *
 * Self-heal (optional):
 *  - Requeues deadlettered EXIT/CLOSE jobs only if trade is still OPEN (paper mode)
 *  - IMPORTANT: requeues the SAME ROW to avoid ux_execution_jobs_intent_type duplicates
 *
 * Env vars:
 *  - SUPABASE_URL
 *  - SUPABASE_SERVICE_KEY
 *  - WORKER_ENABLED ("true"/"false")
 *  - WORKER_ID
 *  - TYPES (e.g. "execute_intent" or JSON '["execute_intent"]')
 *  - POLL_MS (default 2000)
 *  - JOB_TIMEOUT_MS (default 60000)
 *  - WORKER_WEBHOOK_URL (e.g. https://ladder-bot-production.up.railway.app/webhook/worker)
 *  - API_SECRET (must match ladder-bot API_SECRET)
 *
 * Optional:
 *  - MAX_ATTEMPTS (default 3)
 *  - RETRY_BACKOFF_MS (default 5000)   // base backoff; multiplied by attempts
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
    return await fetch(url, { ...opts, signal: controller.signal });
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
function isExitAction(action) {
  const a = String(action || "").toLowerCase();
  return a === "close" || a === "exit" || a === "sell";
}
function msBackoff(baseMs, attempts) {
  // attempts starts at 0 in your rows; backoff uses (attempts+1)
  const n = Math.max(1, Number(attempts || 0) + 1);
  return baseMs * n;
}

// ---------- config ----------
const TAG = "AUX";
const WORKER_ENABLED = envBool("WORKER_ENABLED", true);
const WORKER_ID = process.env.WORKER_ID || "ladder-worker-1";
const TYPES = parseTypes(process.env.TYPES || process.env.WORKER_TYPES || "execute_intent");
const POLL_MS = envInt("POLL_MS", 2000);
const JOB_TIMEOUT_MS = envInt("JOB_TIMEOUT_MS", 60000);

const MAX_ATTEMPTS = envInt("MAX_ATTEMPTS", 3);
const RETRY_BACKOFF_MS = envInt("RETRY_BACKOFF_MS", 5000);

const SELFHEAL_DEADLETTER = envBool("SELFHEAL_DEADLETTER", true);
const SELFHEAL_BATCH = envInt("SELFHEAL_BATCH", 25);

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const WORKER_WEBHOOK_URL = normalizeWebhookUrl(
  process.env.WORKER_WEBHOOK_URL || process.env.WEBHOOK_URL || process.env.WORKER_WEBHOOK || ""
);

const API_SECRET = safeTrim(process.env.API_SECRET || "");

const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const hasWebhook = Boolean(WORKER_WEBHOOK_URL);
const hasApiSecret = Boolean(API_SECRET);

// ---------- start log ----------
log({
  tag: TAG,
  msg: "WORKER_STARTED",
  ts: nowIso(),
  WORKER_ENABLED,
  WORKER_ID,
  TYPES,
  POLL_MS,
  JOB_TIMEOUT_MS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  SELFHEAL_DEADLETTER,
  SELFHEAL_BATCH,
  hasSupabase,
  hasWebhook,
  hasApiSecret,
  webhook_url_prefix: WORKER_WEBHOOK_URL ? WORKER_WEBHOOK_URL.slice(0, 80) : null,
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
  const now = nowIso();

  // IMPORTANT: only runnable now (run_at is null OR run_at <= now)
  const { data, error } = await sb
    .from("execution_jobs")
    .select(
      "id,type,status,payload,attempts,created_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id"
    )
    .in("type", types)
    .eq("status", "queued")
    .is("claimed_by", null)
    .or(`run_at.is.null,run_at.lte.${now}`)
    .order("run_at", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function claimJob(jobId) {
  const now = nowIso();

  // Atomic claim: only if still queued + unclaimed + runnable now
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
    .or(`run_at.is.null,run_at.lte.${now}`)
    .select(
      "id,type,status,payload,attempts,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id"
    )
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

async function markFailedDeadletter(jobId, lastErrorCode) {
  const now = nowIso();
  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "failed",
      heartbeat_at: now,
      last_step: "failed_deadletter",
      last_error: lastErrorCode || "deadletter_max_attempts",
    })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID);

  if (error) throw error;
}

async function requeueWithBackoff(job, lastErrorCode) {
  const now = new Date();
  const backoffMs = msBackoff(RETRY_BACKOFF_MS, job.attempts);
  const nextRunAt = new Date(now.getTime() + backoffMs).toISOString();
  const nextAttempts = Number(job.attempts || 0) + 1;

  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "queued",
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: now.toISOString(),
      last_step: `retry_queued_${nextAttempts}`,
      last_error: lastErrorCode || "retry",
      attempts: nextAttempts,
      run_at: nextRunAt,
    })
    .eq("id", job.id)
    .eq("claimed_by", WORKER_ID);

  if (error) throw error;

  log({
    tag: TAG,
    msg: "JOB_REQUEUED",
    ts: nowIso(),
    id: job.id,
    attempt: nextAttempts,
    next_run_at: nextRunAt,
    last_error: lastErrorCode,
  });
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
    // include multiple common header styles for compatibility
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

// ---------- selfheal helpers ----------
async function tradeIsOpen(tradeId) {
  if (!tradeId) return null;
  const { data, error } = await sb.from("trades_prod").select("id,status,metadata").eq("id", tradeId).limit(1);
  if (error) throw error;
  const row = data && data[0] ? data[0] : null;
  if (!row) return null;

  // optional: only selfheal paper trades
  const mode = row.metadata && row.metadata.mode ? String(row.metadata.mode) : null;
  if (mode && mode !== "paper") return false;

  return String(row.status || "").toLowerCase() === "open";
}

/**
 * IMPORTANT:
 * We MUST NOT insert a new job with same (intent_id,type) because of ux_execution_jobs_intent_type.
 * Selfheal should "revive" the SAME ROW by resetting it back to queued.
 */
async function selfhealRequeueSameJob(oldJob, patchPayload) {
  const now = nowIso();
  const mergedPayload = {
    ...(oldJob.payload || {}),
    ...(patchPayload || {}),
    selfheal_prev_status: oldJob.status,
    selfheal_prev_last_error: oldJob.last_error,
    selfheal_prev_last_step: oldJob.last_step,
    selfheal_at: now,
    created_from: "worker_selfheal_requeue_deadletter",
  };

  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "queued",
      attempts: 0,
      run_at: now,
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: now,
      last_error: null,
      last_step: "selfheal_requeued",
      payload: mergedPayload,
    })
    .eq("id", oldJob.id);

  if (error) throw error;
}

async function selfhealDeadletters(batch) {
  if (!SELFHEAL_DEADLETTER) return 0;

  const { data: dead, error } = await sb
    .from("execution_jobs")
    .select("id,intent_id,type,status,payload,created_at,run_at,last_error,last_step,attempts")
    .eq("status", "failed")
    .eq("last_error", "deadletter_max_attempts")
    .order("created_at", { ascending: true })
    .limit(batch);

  if (error) throw error;
  if (!dead || dead.length === 0) return 0;

  // pull intents only to access raw_signal.trade_id (NO execution_intents.trade_id usage)
  const intentIds = dead.map((j) => j.intent_id).filter(Boolean);
  const { data: intents, error: e2 } = await sb
    .from("execution_intents")
    .select("id,raw_signal,action,symbol,execution_mode")
    .in("id", intentIds);

  if (e2) throw e2;
  const intentMap = new Map((intents || []).map((i) => [i.id, i]));

  let requeued = 0;

  for (const j of dead) {
    const intent = j.intent_id ? intentMap.get(j.intent_id) : null;

    const action = (j.payload && j.payload.action) || (intent ? intent.action : null);
    if (!isExitAction(action)) continue;

    const tradeId =
      (j.payload && j.payload.trade_id) ||
      (intent && intent.raw_signal ? intent.raw_signal.trade_id || intent.raw_signal["trade_id"] : null);

    const open = await tradeIsOpen(tradeId);
    if (open !== true) continue;

    await selfhealRequeueSameJob(j, {
      action,
      symbol: (j.payload && j.payload.symbol) || (intent ? intent.symbol : null),
      execution_mode: (j.payload && j.payload.execution_mode) || (intent ? intent.execution_mode : "paper"),
      trade_id: tradeId,
    });

    requeued += 1;

    log({
      tag: TAG,
      msg: "SELFHEAL_REQUEUED",
      ts: nowIso(),
      job_id: j.id,
      intent_id: j.intent_id,
      trade_id: tradeId,
      action,
    });
  }

  return requeued;
}

// ---------- main loop ----------
async function loop() {
  while (true) {
    try {
      log({ tag: TAG, msg: "POLL", ts: nowIso(), types: TYPES });

      // opportunistic selfheal (safe; does nothing if none)
      await selfhealDeadletters(SELFHEAL_BATCH);

      const candidate = await pickQueuedJob(TYPES);
      if (!candidate) {
        await sleep(POLL_MS);
        continue;
      }

      const claimed = await claimJob(candidate.id);
      if (!claimed) {
        // race condition
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
        attempts: claimed.attempts,
      });

      const result = await executeViaWebhook(claimed);

      if (result.ok) {
        await completeJob(claimed.id);
        log({ tag: TAG, msg: "JOB_COMPLETED", ts: nowIso(), id: claimed.id, type: claimed.type });
      } else {
        const attempts = Number(claimed.attempts || 0);

        // IMPORTANT: persisted retry using DB attempts
        if (attempts + 1 >= MAX_ATTEMPTS) {
          await markFailedDeadletter(claimed.id, "deadletter_max_attempts");
          log({
            tag: TAG,
            msg: "JOB_DEADLETTERED",
            ts: nowIso(),
            id: claimed.id,
            type: claimed.type,
            last_error: result.code,
            detail: result.detail,
          });
        } else {
          await requeueWithBackoff(claimed, result.code);
          log({
            tag: TAG,
            msg: "JOB_WEBHOOK_FAILED_RETRYING",
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
