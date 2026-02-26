/**
 * worker.js (CommonJS)
 * Production-safe execution worker for Railway + Supabase.
 *
 * Core job: claim execution_jobs(status='queued') runnable now and POST to WORKER_WEBHOOK_URL.
 *
 * Optional emergency mode (OFF by default):
 *   ENQUEUE_FROM_APPROVED=1
 *   -> backfills / requeues execution_jobs from execution_intents(status='approved')
 *
 * Env vars expected:
 *  - SUPABASE_URL
 *  - SUPABASE_SERVICE_KEY
 *  - WORKER_ENABLED
 *  - WORKER_ID
 *  - TYPES                  (or WORKER_TYPES)
 *  - POLL_MS
 *  - HEARTBEAT_SECS
 *  - JOB_TIMEOUT_MS
 *  - WORKER_WEBHOOK_URL
 *  - API_SECRET
 *
 * Optional:
 *  - ENQUEUE_FROM_APPROVED  (default 0)
 *  - ENQUEUE_BATCH          (default 25)
 *  - MAX_ATTEMPTS           (default 3)
 *  - RETRY_BACKOFF_MS       (default 5000)
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

function upper(v) {
  return String(v || "").toUpperCase();
}

// ---------- config ----------
const TAG = "AUX";

const WORKER_ENABLED = envBool("WORKER_ENABLED", true);
const WORKER_ID = process.env.WORKER_ID || "ladder-worker-1";

// support TYPES or WORKER_TYPES (some repos use one or the other)
const TYPES = parseTypes(process.env.TYPES || process.env.WORKER_TYPES || "execute_intent");

const POLL_MS = envInt("POLL_MS", 2000);
const HEARTBEAT_SECS = envInt("HEARTBEAT_SECS", 20);
const JOB_TIMEOUT_MS = envInt("JOB_TIMEOUT_MS", 60000);

const ENQUEUE_FROM_APPROVED = envBool("ENQUEUE_FROM_APPROVED", false);
const ENQUEUE_BATCH = envInt("ENQUEUE_BATCH", 25);

const MAX_ATTEMPTS = envInt("MAX_ATTEMPTS", 3);
const RETRY_BACKOFF_MS = envInt("RETRY_BACKOFF_MS", 5000);

const SUPABASE_URL = safeTrim(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_KEY = safeTrim(process.env.SUPABASE_SERVICE_KEY || "");

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
  hasSupabase,
  hasWebhook,
  hasApiSecret,
  supabase_host: supabaseHost,
  webhook_host: webhookHost,
  webhook_url_prefix: WORKER_WEBHOOK_URL ? WORKER_WEBHOOK_URL.slice(0, 55) : null,
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
    hint: "Set WORKER_WEBHOOK_URL (or WEBHOOK_URL) to ladder-bot executor endpoint (usually /webhook/worker)",
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

// ---------- queue audit (debug, safe) ----------
async function countJobs(whereFn) {
  const q = sb.from("execution_jobs").select("id", { count: "exact", head: true });
  const { q2, error: buildErr } = whereFn ? whereFn(q) : { q2: q, error: null };
  if (buildErr) throw buildErr;
  const { count, error } = await (q2 || q);
  if (error) throw error;
  return count || 0;
}

async function queueAudit() {
  try {
    const statusCounts = {
      queued: await countJobs((q) => ({ q2: q.eq("status", "queued") })),
      running: await countJobs((q) => ({ q2: q.eq("status", "running") })),
      completed: await countJobs((q) => ({ q2: q.eq("status", "completed") })),
      failed: await countJobs((q) => ({ q2: q.eq("status", "failed") })),
      archived: await countJobs((q) => ({ q2: q.eq("status", "archived") })),
      cancelled: await countJobs((q) => ({ q2: q.eq("status", "cancelled") })),
    };

    const now = nowIso();
    const { count: queuedForTypes, error: e2 } = await sb
      .from("execution_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued")
      .is("claimed_by", null)
      .in("type", TYPES)
      .or(`run_at.lte.${now},run_at.is.null`);
    if (e2) throw e2;

    async function countIntentsByStatus(status) {
      const { count, error } = await sb
        .from("execution_intents")
        .select("id", { count: "exact", head: true })
        .eq("status", status);
      if (error) throw error;
      return count || 0;
    }

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
      .select("id,type,status,claimed_by,run_at,created_at,attempts,last_step,last_error,intent_id")
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
  } catch (err) {
    log({
      tag: TAG,
      msg: "QUEUE_AUDIT_ERROR",
      ts: nowIso(),
      error: String(err && err.message ? err.message : err),
    });
  }
}

// ---------- DB helpers ----------
async function getTradeStatus(tradeId) {
  if (!tradeId) return null;
  const { data, error } = await sb
    .from("trades_prod")
    .select("id,status,closed_at")
    .eq("id", tradeId)
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function getLatestJobForIntent(intentId) {
  const { data, error } = await sb
    .from("execution_jobs")
    .select("id,status,created_at,attempts,last_error,last_step,run_at,claimed_by")
    .eq("intent_id", intentId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function hasRunnableJobForIntent(intentId) {
  const now = nowIso();
  const { count, error } = await sb
    .from("execution_jobs")
    .select("id", { count: "exact", head: true })
    .eq("intent_id", intentId)
    .in("status", ["queued", "running"])
    .or(`run_at.lte.${now},run_at.is.null`);
  if (error) throw error;
  return (count || 0) > 0;
}

async function insertJobForIntent(intent, reason) {
  const now = nowIso();
  const payload = {
    intent_id: intent.id,
    action: intent.action,
    symbol: intent.symbol,
    execution_mode: intent.execution_mode || "paper",
    trade_id: intent.trade_id || null,
    created_from: "worker_enqueue_from_approved",
    enqueue_reason: reason || "unknown",
    ts: now,
  };

  const row = {
    // id omitted -> db default uuid
    created_at: now,
    run_at: now,
    intent_id: intent.id,
    type: "execute_intent",
    payload,
    status: "queued",
    attempts: 0,
    last_error: null,
    claimed_by: null,
    claimed_at: null,
    heartbeat_at: null,
    run_id: null,
    last_step: "enqueued_by_worker",
  };

  const { error } = await sb.from("execution_jobs").insert([row]);
  if (error) throw error;
}

// ---------- emergency: enqueue / requeue from approved intents ----------
async function enqueueFromApproved(maxBatch) {
  if (!ENQUEUE_FROM_APPROVED) return 0;

  // Pull a batch of approved intents (oldest first)
  const { data: intents, error: e1 } = await sb
    .from("execution_intents")
    .select("id,action,symbol,execution_mode,created_at,trade_id")
    .eq("status", "approved")
    .order("created_at", { ascending: true })
    .limit(maxBatch);

  if (e1) throw e1;
  if (!intents || intents.length === 0) return 0;

  let inserted = 0;

  // We will requeue if:
  // - no runnable queued/running job exists for the intent, AND
  // - (latest job failed/cancelled/archived and retries remain) OR
  // - latest job completed but trade is still open (postcheck repair for close/sell)
  for (const intent of intents) {
    try {
      const runnableExists = await hasRunnableJobForIntent(intent.id);
      if (runnableExists) continue;

      const latest = await getLatestJobForIntent(intent.id);

      // If no job exists at all: enqueue
      if (!latest) {
        await insertJobForIntent(intent, "no_existing_job");
        inserted++;
        continue;
      }

      const latestStatus = String(latest.status || "").toLowerCase();
      const isRetryableStatus = ["failed", "cancelled", "archived"].includes(latestStatus);

      // Retry path for failed/cancelled/archived
      if (isRetryableStatus) {
        const prevAttempts = Number(latest.attempts || 0);
        if (prevAttempts >= MAX_ATTEMPTS) continue;

        // backoff before retry (simple: if last job is very recent, skip)
        const ageMs = Date.now() - new Date(latest.created_at).getTime();
        if (ageMs < RETRY_BACKOFF_MS) continue;

        await insertJobForIntent(intent, `retry_${latestStatus}`);
        inserted++;
        continue;
      }

      // Postcheck repair path:
      // If intent is close/sell and trade is still open, allow a re-run even if latest job completed.
      const act = String(intent.action || "").toLowerCase();
      const needsTradeOpenCheck = act === "close" || act === "sell";
      if (needsTradeOpenCheck && intent.trade_id) {
        const trade = await getTradeStatus(intent.trade_id);
        if (trade && String(trade.status).toLowerCase() === "open") {
          await insertJobForIntent(intent, "postcheck_trade_still_open_repair");
          inserted++;
          continue;
        }
      }
    } catch (e) {
      log({
        tag: TAG,
        msg: "ENQUEUE_INTENT_ERROR",
        ts: nowIso(),
        intent_id: intent.id,
        error: String(e && e.message ? e.message : e),
      });
    }
  }

  log({
    tag: TAG,
    msg: "ENQUEUE_DEBUG",
    ts: nowIso(),
    approved_batch: intents.length,
    inserted,
    note: inserted > 0
      ? "Inserted runnable queued jobs (repair/retry)."
      : "No enqueue needed (runnable jobs exist or not eligible).",
  });

  return inserted;
}

// ---------- core DB ops ----------
async function pickQueuedJob(types) {
  const now = nowIso();
  const { data, error } = await sb
    .from("execution_jobs")
    .select("id,type,status,payload,attempts,created_at,claimed_by,claimed_at,heartbeat_at,last_step,run_at,intent_id")
    .in("type", types)
    .eq("status", "queued")
    .is("claimed_by", null)
    .or(`run_at.lte.${now},run_at.is.null`)
    .order("run_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

async function claimJob(jobId) {
  const now = nowIso();
  // Note: We can’t safely add the run_at filter inside update with PostgREST OR logic reliably,
  // so we enforce runnable in pickQueuedJob and then claim with the queued/unclaimed constraints.
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
    return {
      ok: false,
      code: `webhook_failed_http_${res.status}`,
      detail: text.slice(0, 500),
    };
  }

  return { ok: true, code: "ok", detail: text.slice(0, 500) };
}

// ---------- main loop ----------
let lastAuditAt = 0;

async function loop() {
  while (true) {
    try {
      log({ tag: TAG, msg: "POLL", ts: nowIso(), types: TYPES });

      // audit every ~15s
      const nowMs = Date.now();
      if (nowMs - lastAuditAt > 15000) {
        lastAuditAt = nowMs;
        await queueAudit();
      }

      // Repair/retry enqueuer (only if enabled)
      await enqueueFromApproved(ENQUEUE_BATCH);

      const candidate = await pickQueuedJob(TYPES);
      if (!candidate) {
        const now = nowIso();
        // richer debug (real counts)
        const { count: queuedTotal, error: e1 } = await sb
          .from("execution_jobs")
          .select("id", { count: "exact", head: true })
          .eq("status", "queued")
          .in("type", TYPES);
        if (e1) throw e1;

        const { count: unclaimedRunnable, error: e2 } = await sb
          .from("execution_jobs")
          .select("id", { count: "exact", head: true })
          .eq("status", "queued")
          .is("claimed_by", null)
          .in("type", TYPES)
          .or(`run_at.lte.${now},run_at.is.null`);
        if (e2) throw e2;

        log({
          tag: TAG,
          msg: "PICK_DEBUG",
          ts: nowIso(),
          queued_total_for_types: queuedTotal || 0,
          unclaimed_runnable_now: unclaimedRunnable || 0,
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
        intent_id: claimed.intent_id,
        type: claimed.type,
        claimed_by: claimed.claimed_by,
        last_step: claimed.last_step,
        run_at: claimed.run_at || null,
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
