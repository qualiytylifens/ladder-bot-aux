/* worker.js - Ladder AUX Worker (CommonJS, Railway-friendly, no dotenv) */

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

// ---------- helpers ----------
function nowIso() {
  return new Date().toISOString();
}

function log(obj) {
  try {
    console.log(JSON.stringify(obj));
  } catch {
    console.log(String(obj));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing_env:${name}`);
  return v;
}

function parseBool(v, def = false) {
  if (v == null) return def;
  const s = String(v).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(s);
}

function parseIntSafe(v, def) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
}

/**
 * WORKER_TYPES accepted forms:
 * - execute_intent
 * - execute_intent,other_type
 * - ["execute_intent"]
 * - {"types":["execute_intent"]}  (we’ll read .types if present)
 */
function parseWorkerTypes(raw) {
  const def = ["execute_intent"];
  if (!raw) return def;

  const s = String(raw).trim();

  // JSON forms
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map(String);
      if (parsed && Array.isArray(parsed.types)) return parsed.types.map(String);
    } catch {
      // fall through
    }
  }

  // comma separated or single
  if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
  return [s];
}

async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms)
    ),
  ]);
}

// ---------- config ----------
const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = requiredEnv("SUPABASE_SERVICE_KEY");

const WORKER_ENABLED = parseBool(process.env.WORKER_ENABLED, true);
const WORKER_ID = (process.env.WORKER_ID || "ladder-worker-1").trim();
const WORKER_TYPES = parseWorkerTypes(process.env.WORKER_TYPES);

const POLL_MS = parseIntSafe(process.env.POLL_MS, 2000);
const HEARTBEAT_SECS = parseIntSafe(process.env.HEARTBEAT_SECS, 20);

// Optional: where to send the job to actually execute it
// If you don’t set this, the job will FAIL with a clear reason.
const BOT_WEBHOOK_URL = (process.env.BOT_WEBHOOK_URL || "").trim();
// Optional: bearer token to protect your webhook endpoint
const API_SECRET = (process.env.API_SECRET || "").trim();

// Hard safety timeout per job (ms)
const JOB_TIMEOUT_MS = parseIntSafe(process.env.JOB_TIMEOUT_MS, 60000); // 60s default

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------- Supabase RPC wrappers ----------
async function rpcClaim(workerId, types) {
  // Uses claim_execution_job(text, text[]) (the more specific signature)
  const { data, error } = await supabase.rpc("claim_execution_job", {
    p_worker_id: workerId,
    p_types: types,
  });
  if (error) throw error;
  return data; // { claimed: {...} } or nullish
}

async function rpcHeartbeat(jobId, workerId, runId, step) {
  const { error } = await supabase.rpc("heartbeat_execution_job", {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_run_id: runId,
    p_step: step,
  });
  if (error) throw error;
}

async function rpcFinish(jobId, newStatus, err) {
  const { error } = await supabase.rpc("finish_execution_job", {
    job_id: jobId,
    new_status: newStatus,
    err: err,
  });
  if (error) throw error;
}

// ---------- executor ----------
async function executeJob(job) {
  const jobId = job.id;
  const jobType = job.type;
  const payload = job.payload || {};
  const runId = job.run_id || crypto.randomUUID();

  // Step progression: you will SEE this in Supabase now
  await rpcHeartbeat(jobId, WORKER_ID, runId, "execute_start");

  // Keep heartbeat alive while executing
  let hbTimer = null;
  let hbStep = "executing";
  try {
    hbTimer = setInterval(() => {
      rpcHeartbeat(jobId, WORKER_ID, runId, hbStep).catch(() => {});
    }, HEARTBEAT_SECS * 1000);

    // Only one supported type right now
    if (jobType !== "execute_intent") {
      throw new Error(`unsupported_type:${jobType}`);
    }

    // Require webhook URL so we can actually do the action
    if (!BOT_WEBHOOK_URL) {
      throw new Error("missing_env:BOT_WEBHOOK_URL");
    }

    // Send to your bot/executor service
    // Payload example you already have:
    // { action: "buy", symbol: "XRPC", intent_id: "uuid" }
    hbStep = "sending_webhook";

    const headers = {
      "content-type": "application/json",
    };
    if (API_SECRET) headers["authorization"] = `Bearer ${API_SECRET}`;

    const body = {
      type: jobType,
      job_id: jobId,
      run_id: runId,
      worker_id: WORKER_ID,
      payload,
    };

    const res = await withTimeout(
      fetch(BOT_WEBHOOK_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      JOB_TIMEOUT_MS,
      "webhook"
    );

    hbStep = "webhook_response";

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`webhook_http_${res.status}:${text.slice(0, 200)}`);
    }

    hbStep = "execute_done";
    await rpcHeartbeat(jobId, WORKER_ID, runId, "execute_done");

    // Mark completed
    await rpcFinish(jobId, "completed", null);

    log({
      tag: "AUX",
      msg: "JOB_COMPLETED",
      ts: nowIso(),
      job_id: jobId,
      type: jobType,
      run_id: runId,
      payload,
    });
  } catch (e) {
    const errMsg = e && e.message ? e.message : String(e);
    try {
      await rpcHeartbeat(jobId, WORKER_ID, runId, "execute_failed");
    } catch {}
    try {
      await rpcFinish(jobId, "failed", errMsg);
    } catch {}

    log({
      tag: "AUX",
      msg: "JOB_FAILED",
      ts: nowIso(),
      job_id: jobId,
      type: jobType,
      run_id: runId,
      error: errMsg,
    });
  } finally {
    if (hbTimer) clearInterval(hbTimer);
  }
}

// ---------- main loop ----------
async function main() {
  log({
    tag: "AUX",
    msg: "WORKER_STARTED",
    ts: nowIso(),
    WORKER_ENABLED,
    WORKER_ID,
    TYPES: WORKER_TYPES,
    POLL_MS,
    HEARTBEAT_SECS,
    JOB_TIMEOUT_MS,
    hasWebhook: Boolean(BOT_WEBHOOK_URL),
  });

  if (!WORKER_ENABLED) {
    log({ tag: "AUX", msg: "WORKER_DISABLED_BY_ENV", ts: nowIso() });
    return;
  }

  while (true) {
    try {
      // Claim 1 job at a time
      const claimedWrap = await rpcClaim(WORKER_ID, WORKER_TYPES);
      const claimed = claimedWrap && claimedWrap.claimed ? claimedWrap.claimed : null;

      if (!claimed) {
        await sleep(POLL_MS);
        continue;
      }

      const jobId = claimed.id;
      const runId = claimed.run_id || crypto.randomUUID();

      // Immediately heartbeat with a clear step (not just "claimed")
      await rpcHeartbeat(jobId, WORKER_ID, runId, "claimed_ok");

      log({
        tag: "AUX",
        msg: "JOB_CLAIMED",
        ts: nowIso(),
        job_id: jobId,
        type: claimed.type,
        run_id: runId,
        payload: claimed.payload || {},
      });

      // Execute (with real step progression + timeout)
      await executeJob({
        id: jobId,
        type: claimed.type,
        run_id: runId,
        payload: claimed.payload || {},
      });

      // small breather
      await sleep(250);
    } catch (e) {
      const errMsg = e && e.message ? e.message : String(e);
      log({ tag: "AUX", msg: "LOOP_ERROR", ts: nowIso(), error: errMsg });
      await sleep(Math.max(POLL_MS, 2000));
    }
  }
}

main().catch((e) => {
  const errMsg = e && e.message ? e.message : String(e);
  log({ tag: "AUX", msg: "FATAL", ts: nowIso(), error: errMsg });
  process.exit(1);
});
