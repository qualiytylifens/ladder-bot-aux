/**
 * ladder-bot-aux / worker.js
 * Minimal job worker:
 * - claims jobs from Supabase via RPC claim_execution_job(worker_id, types[])
 * - sends heartbeats via heartbeat_execution_job(job_id, worker_id, run_id, step)
 * - executes job by POSTing to BOT_WEBHOOK_URL (optional)
 * - finishes job via finish_execution_job(job_id, new_status, err)
 *
 * CommonJS (no "type": "module" needed).
 */

const dotenv = require("dotenv");
dotenv.config();

const WORKER_ENABLED = String(process.env.WORKER_ENABLED || "").toLowerCase() !== "0" &&
  String(process.env.WORKER_ENABLED || "").toLowerCase() !== "false";

const WORKER_ID = String(process.env.WORKER_ID || "ladder-worker-1");
const SUPABASE_URL = String(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_KEY = String(process.env.SUPABASE_SERVICE_KEY || "");

const BOT_WEBHOOK_URL = String(process.env.BOT_WEBHOOK_URL || ""); // optional but recommended
const API_SECRET = String(process.env.API_SECRET || ""); // optional depending on ladder-bot auth

const POLL_MS = Number(process.env.POLL_MS || 2000);
const HEARTBEAT_SECS = Number(process.env.HEARTBEAT_SECS || 20);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 60000);

// WORKER_TYPES can be:
// - execute_intent
// - execute_intent,other_type
// - ["execute_intent"]
// - {"types":["execute_intent"]}  (we’ll accept common mistakes)
function parseWorkerTypes(raw) {
  const s = String(raw || "").trim();
  if (!s) return ["execute_intent"];

  // JSON?
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map(String);
      if (parsed && Array.isArray(parsed.types)) return parsed.types.map(String);
    } catch (e) {
      // fall through
    }
  }

  // CSV / single
  return s.split(",").map(x => x.trim()).filter(Boolean);
}

const WORKER_TYPES = parseWorkerTypes(process.env.WORKER_TYPES);

function log(tag, obj) {
  const ts = new Date().toISOString();
  if (obj !== undefined) {
    console.log(`[${tag}] ${ts}`, typeof obj === "string" ? obj : JSON.stringify(obj));
  } else {
    console.log(`[${tag}] ${ts}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

async function sbRpc(fnName, bodyObj) {
  requireEnv("SUPABASE_URL", SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_KEY", SUPABASE_SERVICE_KEY);

  const url = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${fnName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(bodyObj || {}),
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}

  if (!res.ok) {
    const msg = `Supabase RPC ${fnName} failed: ${res.status} ${res.statusText} :: ${text}`;
    throw new Error(msg);
  }
  return json;
}

async function claimJob() {
  // Uses claim_execution_job(text,text[]) returning jsonb
  const claimed = await sbRpc("claim_execution_job", {
    p_worker_id: WORKER_ID,
    p_types: WORKER_TYPES,
  });

  // Expected shape:
  // { claimed: { id, type, run_id, payload: { ... } } }
  // Or sometimes null/{} if no jobs
  if (!claimed || !claimed.claimed || !claimed.claimed.id) return null;
  return claimed.claimed;
}

async function heartbeat(jobId, runId, step) {
  // heartbeat_execution_job(p_job_id uuid, p_worker_id text, p_run_id uuid, p_step text)
  try {
    await sbRpc("heartbeat_execution_job", {
      p_job_id: jobId,
      p_worker_id: WORKER_ID,
      p_run_id: runId,
      p_step: step || "running",
    });
  } catch (e) {
    // Don't crash worker on heartbeat errors; log and continue.
    log("HB_ERR", { jobId, err: String(e.message || e) });
  }
}

async function finish(jobId, newStatus, errText) {
  // finish_execution_job(job_id uuid, new_status text, err text)
  await sbRpc("finish_execution_job", {
    job_id: jobId,
    new_status: newStatus,
    err: errText || null,
  });
}

async function callWebhook(job) {
  if (!BOT_WEBHOOK_URL) {
    throw new Error("BOT_WEBHOOK_URL is not set (worker has nothing to execute)");
  }

  // You can change the path if your ladder-bot expects another endpoint.
  // Keep it minimal + explicit.
  const target = BOT_WEBHOOK_URL.replace(/\/$/, "");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);

  try {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(API_SECRET ? { "x-api-secret": API_SECRET } : {}),
      },
      body: JSON.stringify({
        type: job.type,
        job_id: job.id,
        run_id: job.run_id,
        payload: job.payload,
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`WEBHOOK ${res.status} ${res.statusText} :: ${text}`);
    }
    return { ok: true, body: text };
  } finally {
    clearTimeout(timeout);
  }
}

async function processJob(job) {
  // Heartbeat timer while job is processing
  let hbTimer = null;
  const hbEveryMs = Math.max(5, HEARTBEAT_SECS) * 1000;

  try {
    log("JOB_CLAIMED", { id: job.id, type: job.type, run_id: job.run_id, payload: job.payload });

    // immediate heartbeat
    await heartbeat(job.id, job.run_id, "claimed");

    hbTimer = setInterval(() => {
      heartbeat(job.id, job.run_id, "processing").catch(() => {});
    }, hbEveryMs);

    // Execute job (webhook)
    log("JOB_EXEC", { id: job.id, target: BOT_WEBHOOK_URL ? "webhook" : "none" });
    const out = await callWebhook(job);
    log("JOB_EXEC_OK", { id: job.id, out });

    await heartbeat(job.id, job.run_id, "finish_ok");
    await finish(job.id, "completed", null);

    log("JOB_DONE", { id: job.id, status: "completed" });
  } catch (e) {
    const errText = String(e && e.message ? e.message : e);
    log("JOB_FAIL", { id: job.id, err: errText });

    try { await heartbeat(job.id, job.run_id, "finish_failed"); } catch (_) {}
    try { await finish(job.id, "failed", errText.slice(0, 900)); } catch (_) {}

    log("JOB_DONE", { id: job.id, status: "failed" });
  } finally {
    if (hbTimer) clearInterval(hbTimer);
  }
}

async function main() {
  log("WORKER_STARTED", {
    tag: "AUX",
    WORKER_ENABLED,
    WORKER_ID,
    TYPES: WORKER_TYPES,
    POLL_MS,
    HEARTBEAT_SECS,
    JOB_TIMEOUT_MS,
    hasWebhook: Boolean(BOT_WEBHOOK_URL),
  });

  if (!WORKER_ENABLED) {
    log("DISABLED", "WORKER_ENABLED is false/0. Exiting.");
    process.exit(0);
  }

  // Validate critical envs early so Railway logs show it
  requireEnv("SUPABASE_URL", SUPABASE_URL);
  requireEnv("SUPABASE_SERVICE_KEY", SUPABASE_SERVICE_KEY);

  while (true) {
    try {
      log("POLL", { types: WORKER_TYPES });
      const job = await claimJob();
      if (!job) {
        // no jobs
        await sleep(POLL_MS);
        continue;
      }
      await processJob(job);
      // small yield
      await sleep(250);
    } catch (e) {
      log("LOOP_ERR", { err: String(e.message || e) });
      await sleep(Math.max(1000, POLL_MS));
    }
  }
}

main().catch((e) => {
  log("FATAL", { err: String(e.message || e) });
  process.exit(1);
});
