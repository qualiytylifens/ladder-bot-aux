/**
 * worker.js — HARDENED PRODUCTION VERSION
 * Institutional-safe execution worker for Railway.
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

// ---------- config ----------
const TAG = "AUX";
const WORKER_ENABLED = envBool("WORKER_ENABLED", true);
const WORKER_ID = process.env.WORKER_ID || "ladder-worker-1";
const TYPES = parseTypes(process.env.TYPES || "execute_intent");
const POLL_MS = envInt("POLL_MS", 2000);
const JOB_TIMEOUT_MS = envInt("JOB_TIMEOUT_MS", 60000);
const STALE_JOB_SECS = envInt("STALE_JOB_SECS", 180);

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const WORKER_WEBHOOK_URL = safeTrim(process.env.WORKER_WEBHOOK_URL || "");
const API_SECRET = safeTrim(process.env.API_SECRET || "");

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------- stale recovery ----------
async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - STALE_JOB_SECS * 1000).toISOString();

  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "queued",
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: null,
      last_step: "recovered_stale",
    })
    .in("status", ["running"])
    .lt("heartbeat_at", cutoff);

  if (error) {
    log({ tag: TAG, msg: "STALE_RECOVERY_ERROR", error: error.message });
  }
}

// ---------- pick job ----------
async function pickQueuedJob(types) {
  // 🔥 try to recover stale jobs first
  await recoverStaleJobs();

  const { data, error } = await sb
    .from("execution_jobs")
    .select("*")
    .in("type", types)
    .eq("status", "queued")
    .or("claimed_by.is.null,claimed_by.eq.")
    .order("created_at", { ascending: true })
    .limit(1);

  if (error) throw error;

  log({
    tag: TAG,
    msg: "PICK_DEBUG",
    ts: nowIso(),
    queued_seen: data?.length || 0,
    runnable_found: !!(data && data[0]),
  });

  return data && data[0] ? data[0] : null;
}

// ---------- claim ----------
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
    .select()
    .limit(1);

  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

// ---------- completion ----------
async function completeJob(jobId) {
  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "completed",
      last_step: "completed",
      heartbeat_at: nowIso(),
    })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID);

  if (error) throw error;
}

async function failJob(jobId, code) {
  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "failed",
      last_error: code || "unknown_error",
      last_step: "failed",
      heartbeat_at: nowIso(),
    })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID);

  if (error) throw error;
}

// ---------- webhook ----------
async function executeViaWebhook(job) {
  if (!WORKER_WEBHOOK_URL) {
    return { ok: false, code: "missing_webhook_url" };
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
    "x-api-secret": API_SECRET,
    authorization: `Bearer ${API_SECRET}`,
  };

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
      detail: text.slice(0, 300),
    };
  }

  return { ok: true };
}

// ---------- main loop ----------
async function loop() {
  while (true) {
    try {
      const job = await pickQueuedJob(TYPES);

      if (!job) {
        await sleep(POLL_MS);
        continue;
      }

      const claimed = await claimJob(job.id);
      if (!claimed) {
        await sleep(250);
        continue;
      }

      log({
        tag: TAG,
        msg: "JOB_CLAIMED",
        ts: nowIso(),
        id: claimed.id,
      });

      const result = await executeViaWebhook(claimed);

      if (result.ok) {
        await completeJob(claimed.id);
        log({ tag: TAG, msg: "JOB_COMPLETED", id: claimed.id });
      } else {
        await failJob(claimed.id, result.code);
        log({ tag: TAG, msg: "JOB_FAILED", id: claimed.id, code: result.code });
      }
    } catch (err) {
      log({ tag: TAG, msg: "LOOP_ERROR", error: err.message });
      await sleep(Math.max(1000, POLL_MS));
    }
  }
}

loop();
