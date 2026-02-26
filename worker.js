/**
 * worker.js (CommonJS)
 * Production-safe execution worker for Railway.
 *
 * Key guarantees:
 * 1) NEVER mark a job completed if ladder-bot returns an application-level failure (even if HTTP 200)
 * 2) Only pull runnable jobs (run_at <= now or run_at is null)
 * 3) Emit QUEUE_AUDIT truth logs so "not pulling" is never ambiguous again
 * 4) Retry failed jobs with backoff; archive after MAX_ATTEMPTS
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
 *  - MAX_ATTEMPTS
 *  - RETRY_BACKOFF_MS
 *  - WORKER_WEBHOOK_URL / WORKER_WEBHOOK_URL / WEBHOOK_URL / WORKER_WEBHOOK_URL / BOT_WEBHOOK_URL
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
function getWebhookUrlFromEnv() {
  // tolerate naming mismatches across services
  const candidates = [
    process.env.WORKER_WEBHOOK_URL,
    process.env.WORKER_WEBHOOK_URL,
    process.env.WORKER_WEBHOOK_URL,
    process.env.BOT_WEBHOOK_URL,
    process.env.WEBHOOK_URL,
  ].map(normalizeWebhookUrl);

  return candidates.find(Boolean) || "";
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

function addMsToIso(msFromNow) {
  return new Date(Date.now() + msFromNow).toISOString();
}

// ---------- config ----------
const TAG = "AUX";
const WORKER_ENABLED = envBool("WORKER_ENABLED", true);
const WORKER_ID = safeTrim(process.env.WORKER_ID || "ladder-worker-1");
const TYPES = parseTypes(process.env.TYPES || "execute_intent");
const POLL_MS = envInt("POLL_MS", 2000);
const HEARTBEAT_SECS = envInt("HEARTBEAT_SECS", 20);
const JOB_TIMEOUT_MS = envInt("JOB_TIMEOUT_MS", 60000);

const MAX_ATTEMPTS = envInt("MAX_ATTEMPTS", 3);
const RETRY_BACKOFF_MS = envInt("RETRY_BACKOFF_MS", 5000);

const SUPABASE_URL = safeTrim(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_KEY = safeTrim(process.env.SUPABASE_SERVICE_KEY || "");

const WORKER_WEBHOOK_URL = getWebhookUrlFromEnv();
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
  HEARTBEAT_SECS,
  JOB_TIMEOUT_MS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  hasSupabase,
  hasWebhook,
  hasApiSecret,
  webhook_url: hasWebhook ? WORKER_WEBHOOK_URL : "(missing)",
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
    hint: "Set WORKER_WEBHOOK_URL (or WEBHOOK_URL / BOT_WEBHOOK_URL) to ladder-bot /webhook/worker",
  });
  process.exit(1);
}

if (!hasApiSecret) {
  log({
    tag: TAG,
    msg: "FATAL_MISSING_API_SECRET",
    ts: nowIso(),
    hint: "Set API_SECRET (must match ladder-bot) to avoid webhook_failed_http_401",
  });
  process.exit(1);
}

// ---------- supabase client ----------
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------- DB ops ----------
async function queueAudit(types) {
  // Truth telemetry: what exists vs what is runnable
  const { count: totalQueued, error: e1 } = await sb
    .from("execution_jobs")
    .select("id", { count: "exact", head: true })
    .in("type", types)
    .eq("status", "queued");

  if (e1) throw e1;

  const { count: unclaimedQueued, error: e2 } = await sb
    .from("execution_jobs")
    .select("id", { count: "exact", head: true })
    .in("type", types)
    .eq("status", "queued")
    .is("claimed_by", null);

  if (e2) throw e2;

  // runnable: unclaimed + (run_at is null or run_at <= now)
  // We can’t express "or" perfectly with builder across null+lte without .or()
  const now = nowIso();
  const { data: runnableSample, error: e3 } = await sb
    .from("execution_jobs")
    .select("id,run_at")
    .in("type", types)
    .eq("status", "queued")
    .is("claimed_by", null)
    .or(`run_at.is.null,run_at.lte.${now}`)
    .order("run_at", { ascending: true, nullsFirst: true })
    .limit(5);

  if (e3) throw e3;

  const runnableCount = runnableSample?.length ? null : null; // we don't count here to avoid extra query

  const { data: claimedSample, error: e4 } = await sb
    .from("execution_jobs")
    .select("claimed_by")
    .in("type", types)
    .eq("status", "queued")
    .not("claimed_by", "is", null)
    .limit(5);

  if (e4) throw e4;

  const oldestRunAt = runnableSample?.[0]?.run_at ?? null;

  log({
    tag: TAG,
    msg: "QUEUE_AUDIT",
    ts: nowIso(),
    totalQueued: totalQueued ?? 0,
    unclaimedQueued: unclaimedQueued ?? 0,
    runnableSampleIds: (runnableSample || []).map((r) => r.id),
    oldest_run_at: oldestRunAt,
    claimedBySample: (claimedSample || []).map((r) => r.claimed_by).filter(Boolean),
  });
}

async function pickQueuedJob(types) {
  const now = nowIso();

  // Pull ONLY runnable jobs: queued + unclaimed + (run_at is null or <= now)
  const { data, error } = await sb
    .from("execution_jobs")
    .select("id,type,status,payload,attempts,created_at,run_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error")
    .in("type", types)
    .eq("status", "queued")
    .is("claimed_by", null)
    .or(`run_at.is.null,run_at.lte.${now}`)
    .order("run_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function claimJob(jobId) {
  const now = nowIso();
  // Only claim if still queued + unclaimed
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

async function heartbeat(jobId) {
  const now = nowIso();
  const { error } = await sb
    .from("execution_jobs")
    .update({ heartbeat_at: now, last_step: "running" })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID);

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

async function archiveJob(jobId, lastErrorCode) {
  const now = nowIso();
  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "archived",
      heartbeat_at: now,
      last_step: "archived",
      last_error: lastErrorCode || "archived_unknown",
    })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID);

  if (error) throw error;
}

async function retryOrArchive(job, lastErrorCode) {
  const attempts = Number.isFinite(job.attempts) ? job.attempts : 0;
  const nextAttempts = attempts + 1;

  if (nextAttempts >= MAX_ATTEMPTS) {
    await archiveJob(job.id, lastErrorCode || "deadletter_max_attempts");
    log({
      tag: TAG,
      msg: "JOB_ARCHIVED_MAX_ATTEMPTS",
      ts: nowIso(),
      id: job.id,
      type: job.type,
      attempts: nextAttempts,
      last_error: lastErrorCode,
    });
    return;
  }

  const runAt = addMsToIso(RETRY_BACKOFF_MS);

  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "queued",
      attempts: nextAttempts,
      last_error: lastErrorCode || "retry_unknown",
      last_step: "retry_scheduled",
      run_at: runAt,
      // keep claimed_by for audit trail? your schema uses claimed_by/claimed_at; we clear so it can be pulled again
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: null,
    })
    .eq("id", job.id)
    .eq("claimed_by", WORKER_ID);

  if (error) throw error;

  log({
    tag: TAG,
    msg: "JOB_REQUEUED",
    ts: nowIso(),
    id: job.id,
    type: job.type,
    attempts: nextAttempts,
    run_at: runAt,
    last_error: lastErrorCode,
  });
}

// ---------- webhook execution ----------
function buildAuthHeaders() {
  const headers = { "content-type": "application/json" };
  headers["x-api-secret"] = API_SECRET;
  headers["x-api-key"] = API_SECRET;
  headers["authorization"] = `Bearer ${API_SECRET}`;
  return headers;
}

function interpretAppResponse(status, text, contentType) {
  // ladder-bot may return HTTP 200 with JSON telling us it failed (postcheck_trade_still_open etc.)
  // We treat those as failures, not completion.
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      const j = JSON.parse(text || "{}");

      // Common patterns to treat as failure:
      // { ok:false, code:"postcheck_trade_still_open", ... }
      // { success:false, code:"...", ... }
      // { error:"..." }
      if (j && (j.ok === false || j.success === false)) {
        const code = String(j.code || j.error_code || "webhook_app_failed");
        const detail = String(j.detail || j.error || text || "").slice(0, 500);
        return { ok: false, code, detail };
      }
      if (j && j.error) {
        const code = String(j.code || "webhook_app_error");
        const detail = String(j.error || "").slice(0, 500);
        return { ok: false, code, detail };
      }
      return { ok: true, code: "ok", detail: text.slice(0, 500) };
    } catch {
      // If it claimed JSON but isn't parseable, treat as failure (data integrity)
      return { ok: false, code: "webhook_bad_json", detail: (text || "").slice(0, 500) };
    }
  }

  // Non-JSON: if HTTP is ok we assume ok, but still keep response text
  return { ok: status >= 200 && status < 300, code: status >= 200 && status < 300 ? "ok" : `webhook_failed_http_${status}`, detail: (text || "").slice(0, 500) };
}

async function executeViaWebhook(job) {
  const body = {
    job_id: job.id,
    type: job.type,
    payload: job.payload || {},
    worker_id: WORKER_ID,
    ts: nowIso(),
  };

  const res = await fetchWithTimeout(
    WORKER_WEBHOOK_URL,
    {
      method: "POST",
      headers: buildAuthHeaders(),
      body: JSON.stringify(body),
    },
    JOB_TIMEOUT_MS
  );

  const contentType = res.headers?.get?.("content-type") || "";
  const text = await res.text().catch(() => "");

  // HTTP-level failure:
  if (!res.ok) {
    return {
      ok: false,
      code: `webhook_failed_http_${res.status}`,
      detail: text.slice(0, 500),
    };
  }

  // App-level interpretation (CRITICAL FIX):
  return interpretAppResponse(res.status, text, contentType);
}

// ---------- main loop ----------
async function loop() {
  while (true) {
    const loopStart = nowMs();
    try {
      log({ tag: TAG, msg: "POLL", ts: nowIso(), types: TYPES });

      // Always emit truth about queue state (prevents “not pulling” confusion)
      await queueAudit(TYPES);

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
        attempts: claimed.attempts || 0,
        run_at: claimed.run_at || null,
        last_step: claimed.last_step,
      });

      // Heartbeat timer while executing
      const hbEveryMs = Math.max(1000, HEARTBEAT_SECS * 1000);
      let hbTimer = null;
      try {
        hbTimer = setInterval(() => {
          heartbeat(claimed.id).catch(() => {});
        }, hbEveryMs);

        const result = await executeViaWebhook(claimed);

        if (result.ok) {
          await completeJob(claimed.id);
          log({ tag: TAG, msg: "JOB_COMPLETED", ts: nowIso(), id: claimed.id, type: claimed.type });
        } else {
          // CRITICAL: app-level failure must not be marked completed
          log({
            tag: TAG,
            msg: "JOB_FAILED_APP_OR_HTTP",
            ts: nowIso(),
            id: claimed.id,
            type: claimed.type,
            last_error: result.code,
            detail: result.detail,
          });
          await retryOrArchive(claimed, result.code);
        }
      } finally {
        if (hbTimer) clearInterval(hbTimer);
      }

      // small jitter
      await sleep(250);
    } catch (err) {
      log({
        tag: TAG,
        msg: "LOOP_ERROR",
        ts: nowIso(),
        error: String(err && err.message ? err.message : err),
        loop_ms: nowMs() - loopStart,
      });
      await sleep(Math.max(1000, POLL_MS));
    }
  }
}

loop();
