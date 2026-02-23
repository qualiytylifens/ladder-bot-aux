/**
 * ladder-bot-aux worker.js
 * - CommonJS (no "type": "module")
 * - No dotenv (Railway env vars only)
 * - Claims jobs from Supabase, heartbeats, calls BOT_WEBHOOK_URL, finishes job
 */

const { createClient } = require("@supabase/supabase-js");

// -------------------- helpers --------------------
function nowISO() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseTypes(raw) {
  // Accept:
  //  - "execute_intent"
  //  - "execute_intent,other"
  //  - '["execute_intent"]'
  //  - '{"execute_intent":true}' (rare)
  if (!raw) return ["execute_intent"];

  const s = String(raw).trim();

  // JSON array
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr.length) return arr.map(String);
    } catch (_) {}
  }

  // JSON object -> keys
  if (s.startsWith("{") && s.endsWith("}")) {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === "object") return Object.keys(obj);
    } catch (_) {}
  }

  // CSV
  if (s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);

  return [s];
}

async function httpPostJson(url, body, apiSecret) {
  const headers = { "content-type": "application/json" };
  if (apiSecret) headers["x-api-key"] = apiSecret;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {}

  return {
    ok: res.ok,
    status: res.status,
    text,
    json,
  };
}

// -------------------- env --------------------
const TAG = process.env.TAG || "AUX";
const WORKER_ENABLED =
  String(process.env.WORKER_ENABLED || "true").toLowerCase() === "true" ||
  String(process.env.WORKER_ENABLED || "1") === "1";

const WORKER_ID = (process.env.WORKER_ID || "ladder-worker-1").trim();
const TYPES = parseTypes(process.env.WORKER_TYPES || process.env.WORKER_TYPES_JSON);

const POLL_MS = Number(process.env.POLL_MS || 2000);
const HEARTBEAT_SECS = Number(process.env.HEARTBEAT_SECS || 20);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 60000);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const BOT_WEBHOOK_URL = process.env.BOT_WEBHOOK_URL; // ladder-bot endpoint to execute intent
const API_SECRET = process.env.API_SECRET; // optional shared secret header x-api-key

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(`[${TAG}] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// -------------------- main loop --------------------
let currentJob = null;
let hbTimer = null;
let jobDeadline = 0;

function log(obj) {
  console.log(`[${TAG}] ${nowISO()} ${JSON.stringify(obj)}`);
}

async function heartbeatTick() {
  if (!currentJob) return;
  const { id: job_id, run_id } = currentJob;

  // heartbeat_execution_job(p_job_id uuid, p_worker_id text, p_run_id uuid, p_step text)
  const step = currentJob.last_step || "running";
  const { error } = await supabase.rpc("heartbeat_execution_job", {
    p_job_id: job_id,
    p_worker_id: WORKER_ID,
    p_run_id: run_id,
    p_step: step,
  });

  if (error) {
    log({ level: "error", msg: "heartbeat_failed", job_id, err: error.message });
  } else {
    log({ msg: "heartbeat_ok", job_id, step });
  }
}

async function finishJob(job_id, new_status, errText) {
  // finish_execution_job(job_id uuid, new_status text, err text)
  const { error } = await supabase.rpc("finish_execution_job", {
    job_id,
    new_status,
    err: errText || null,
  });

  if (error) {
    log({ level: "error", msg: "finish_job_failed", job_id, new_status, err: error.message });
    return false;
  }
  log({ msg: "finish_job_ok", job_id, new_status, err: errText || null });
  return true;
}

/**
 * ✅ FIX: support BOTH claim_execution_job return shapes:
 *  1) OLD shape: { claimed: { id,type,run_id,payload } } or { claimed: null }
 *  2) CURRENT 2-arg overload shape: { id,type,run_id,payload } or NULL
 */
function normalizeClaimResponse(data) {
  if (!data) return null;

  // Shape #1: { claimed: {...} }
  if (data.claimed && typeof data.claimed === "object") {
    const c = data.claimed;
    if (c.id) return c;
    return null;
  }

  // Shape #1b: { claimed: null }
  if ("claimed" in data && (data.claimed === null || data.claimed === false)) return null;

  // Shape #2: direct object { id,type,run_id,payload }
  if (data.id) return data;

  return null;
}

async function claimJob() {
  // claim_execution_job(text, text[]) returns jsonb { id,type,run_id,payload } OR possibly {claimed:{...}}
  const { data, error } = await supabase.rpc("claim_execution_job", {
    p_worker_id: WORKER_ID,
    p_types: TYPES,
  });

  if (error) {
    log({ level: "error", msg: "claim_failed", err: error.message, types: TYPES });
    return null;
  }

  const claimed = normalizeClaimResponse(data);

  // Helpful debug: log raw claim output occasionally (safe)
  if (!claimed) {
    // If data is non-null but we couldn't parse it, log it once
    if (data && typeof data === "object" && Object.keys(data).length) {
      log({ level: "warn", msg: "claim_unparsed_shape", data });
    }
    return null;
  }

  return {
    id: claimed.id,
    type: claimed.type,
    run_id: claimed.run_id,
    payload: claimed.payload || {},
    last_step: "claimed",
  };
}

async function processJob(job) {
  const job_id = job.id;
  const payload = job.payload || {};
  const intent_id = payload.intent_id;
  const symbol = payload.symbol;
  const action = payload.action;

  // Hard guardrails
  if (!BOT_WEBHOOK_URL) {
    await finishJob(job_id, "failed", "missing_BOT_WEBHOOK_URL");
    return;
  }
  if (!intent_id || !symbol || !action) {
    await finishJob(job_id, "failed", "invalid_payload_missing_fields");
    return;
  }

  // Call ladder-bot to execute this intent
  job.last_step = "call_bot_webhook";
  const resp = await httpPostJson(
    BOT_WEBHOOK_URL,
    {
      source: "ladder-bot-aux",
      worker_id: WORKER_ID,
      job_id,
      run_id: job.run_id,
      type: job.type,
      payload,
    },
    API_SECRET
  );

  if (!resp.ok) {
    const errText = `webhook_failed_http_${resp.status}`;
    log({
      level: "error",
      msg: "webhook_failed",
      job_id,
      status: resp.status,
      body: resp.text?.slice(0, 500),
    });
    await finishJob(job_id, "failed", errText);
    return;
  }

  job.last_step = "webhook_ok_finish";
  await finishJob(job_id, "completed", null);
}

async function main() {
  log({
    msg: "WORKER_STARTED",
    tag: TAG,
    WORKER_ENABLED,
    WORKER_ID,
    TYPES,
    POLL_MS,
    HEARTBEAT_SECS,
    JOB_TIMEOUT_MS,
    hasWebhook: !!BOT_WEBHOOK_URL,
  });

  if (!WORKER_ENABLED) {
    log({ msg: "WORKER_DISABLED_BY_ENV" });
    process.exit(0);
  }

  while (true) {
    try {
      // If we are holding a job, enforce timeout
      if (currentJob && Date.now() > jobDeadline) {
        const job_id = currentJob.id;
        log({ level: "error", msg: "job_timeout", job_id });
        await finishJob(job_id, "failed", "job_timeout");
        currentJob = null;
        if (hbTimer) clearInterval(hbTimer);
        hbTimer = null;
      }

      // Claim if idle
      if (!currentJob) {
        log({ msg: "POLL", types: TYPES });
        const job = await claimJob();

        if (!job) {
          await sleep(POLL_MS);
          continue;
        }

        currentJob = job;
        jobDeadline = Date.now() + JOB_TIMEOUT_MS;

        // start heartbeat timer
        if (hbTimer) clearInterval(hbTimer);
        hbTimer = setInterval(() => {
          heartbeatTick().catch(() => {});
        }, Math.max(HEARTBEAT_SECS, 5) * 1000);

        log({ msg: "CLAIMED", job_id: currentJob.id, run_id: currentJob.run_id, payload: currentJob.payload });
      }

      // Process claimed job
      await processJob(currentJob);

      // Clear
      currentJob = null;
      if (hbTimer) clearInterval(hbTimer);
      hbTimer = null;

      await sleep(250); // tiny backoff
    } catch (e) {
      log({ level: "error", msg: "loop_error", err: String(e && e.message ? e.message : e) });
      await sleep(1000);
    }
  }
}

main().catch((e) => {
  console.error(`[${TAG}] fatal`, e);
  process.exit(1);
});
