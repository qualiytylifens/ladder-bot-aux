/**
 * ladder-bot-aux worker.js
 * - CommonJS (no "type": "module")
 * - No dotenv (Railway env vars only)
 * - Claims jobs from Supabase, heartbeats, calls BOT_WEBHOOK_URL, finishes job
 *
 * Updates in this version:
 * - Fix WORKER_ENABLED parsing (previous logic was effectively always true)
 * - Add webhook fetch timeout (prevents hanging at "claimed")
 * - Add execution gate check (latest_execution_gate) before calling ladder-bot
 * - Better failure messages for debugging
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

function parseBool(raw, defaultValue = true) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return defaultValue;
  const s = String(raw).trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(s)) return false;
  if (["true", "1", "yes", "on"].includes(s)) return true;
  return defaultValue;
}

/**
 * POST JSON with timeout (prevents "claimed forever")
 */
async function httpPostJson(url, body, apiSecret, timeoutMs) {
  const headers = { "content-type": "application/json" };
  if (apiSecret) headers["x-api-key"] = apiSecret;

  // Node 18+ has global fetch + AbortController
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs || 15000)));

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
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
  } catch (e) {
    const msg = String(e && e.name ? `${e.name}:${e.message || ""}` : e && e.message ? e.message : e);
    return {
      ok: false,
      status: 0,
      text: msg,
      json: null,
      aborted: msg.toLowerCase().includes("abort"),
    };
  } finally {
    clearTimeout(t);
  }
}

// -------------------- env --------------------
const TAG = process.env.TAG || "AUX";

const WORKER_ENABLED = parseBool(process.env.WORKER_ENABLED, true);
const WORKER_ID = (process.env.WORKER_ID || "ladder-worker-1").trim();

const TYPES = parseTypes(process.env.WORKER_TYPES || process.env.WORKER_TYPES_JSON);

const POLL_MS = Number(process.env.POLL_MS || 2000);
const HEARTBEAT_SECS = Number(process.env.HEARTBEAT_SECS || 20);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 60000);

// NEW: webhook call timeout (so job cannot hang)
const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 15000);

// Gate behavior:
// - If gate says BLOCK, we finish job as "completed" (safe: it’s correctly handled)
//   You can change to "failed" if you want those to show as failures.
const GATE_BLOCK_FINISH_STATUS = (process.env.GATE_BLOCK_FINISH_STATUS || "completed").toLowerCase(); // completed|failed

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

async function claimJob() {
  // claim_execution_job(text, text[]) returns jsonb { claimed: { id,type,run_id,payload } } or { claimed: null }
  const { data, error } = await supabase.rpc("claim_execution_job", {
    p_worker_id: WORKER_ID,
    p_types: TYPES,
  });

  if (error) {
    log({ level: "error", msg: "claim_failed", err: error.message, types: TYPES });
    return null;
  }

  const claimed = data?.claimed || null;
  if (!claimed || !claimed.id) return null;

  return {
    id: claimed.id,
    type: claimed.type,
    run_id: claimed.run_id,
    payload: claimed.payload || {},
    last_step: "claimed",
  };
}

/**
 * Gate check: reads latest_execution_gate for (market='CRYPTO', symbol)
 * Returns: { decision, reason } or null
 */
async function readGateDecision(symbol) {
  try {
    const { data, error } = await supabase
      .from("latest_execution_gate")
      .select("market,symbol,decision,decision_reason,created_at")
      .eq("market", "CRYPTO")
      .eq("symbol", symbol)
      .limit(1);

    if (error) {
      log({ level: "error", msg: "gate_read_failed", symbol, err: error.message });
      return null;
    }
    if (!data || data.length === 0) return null;

    return {
      decision: data[0].decision,
      reason: data[0].decision_reason,
      created_at: data[0].created_at,
    };
  } catch (e) {
    log({ level: "error", msg: "gate_read_exception", symbol, err: String(e && e.message ? e.message : e) });
    return null;
  }
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

  // NEW: Gate check BEFORE calling ladder-bot
  job.last_step = "gate_check";
  const gate = await readGateDecision(symbol);

  if (gate && String(gate.decision || "").toUpperCase() === "BLOCK") {
    const msg = `blocked_by_gate: ${gate.reason || "no_reason"}`;
    log({ msg: "GATE_BLOCK", job_id, symbol, decision: gate.decision, reason: gate.reason });

    // Finish as completed (handled) by default
    const finishStatus = GATE_BLOCK_FINISH_STATUS === "failed" ? "failed" : "completed";
    await finishJob(job_id, finishStatus, msg);
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
    API_SECRET,
    WEBHOOK_TIMEOUT_MS
  );

  if (!resp.ok) {
    const bodySnippet = (resp.text || "").slice(0, 500);
    const errText =
      resp.status === 0
        ? `webhook_failed_network_or_timeout:${bodySnippet}`
        : `webhook_failed_http_${resp.status}:${bodySnippet}`;

    log({
      level: "error",
      msg: "webhook_failed",
      job_id,
      status: resp.status,
      timeout_ms: WEBHOOK_TIMEOUT_MS,
      body: bodySnippet,
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
    WEBHOOK_TIMEOUT_MS,
    gateBlockFinishStatus: GATE_BLOCK_FINISH_STATUS,
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
        log({ level: "error", msg: "job_timeout", job_id, timeout_ms: JOB_TIMEOUT_MS });

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
