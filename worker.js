/**
 * worker.js (CommonJS)
 * Minimal, production-safe execution worker for Railway.
 *
 * Env vars expected (set in Railway):
 *  - SUPABASE_URL
 *  - SUPABASE_SERVICE_KEY
 *  - WORKER_ENABLED
 *  - WORKER_ID
 *  - TYPES
 *  - POLL_MS
 *  - HEARTBEAT_SECS
 *  - JOB_TIMEOUT_MS
 *  - WORKER_WEBHOOK_URL   (executor endpoint, usually ladder-bot /webhook/worker)
 *  - API_SECRET           (shared with ladder-bot; required for auth)
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
  // normalize minor mistakes like trailing spaces
  return safeTrim(u);
}

function lower(v) {
  return String(v || "").toLowerCase();
}

function isExitAction(a) {
  const x = lower(a);
  return x === "close" || x === "sell" || x === "exit";
}

// ---------- config ----------
const TAG = "AUX";
const WORKER_ENABLED = envBool("WORKER_ENABLED", true);
const WORKER_ID = process.env.WORKER_ID || "ladder-worker-1";
const TYPES = parseTypes(process.env.TYPES || "execute_intent");
const POLL_MS = envInt("POLL_MS", 2000);
const HEARTBEAT_SECS = envInt("HEARTBEAT_SECS", 20);
const JOB_TIMEOUT_MS = envInt("JOB_TIMEOUT_MS", 60000);

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const WORKER_WEBHOOK_URL = normalizeWebhookUrl(process.env.WORKER_WEBHOOK_URL || "");
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
  hasSupabase,
  hasWebhook,
  hasApiSecret,
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
    hint: "Set WORKER_WEBHOOK_URL to your executor endpoint (ladder-bot /webhook/worker)",
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
    .select("id,type,status,payload,attempts,created_at,claimed_by,claimed_at,heartbeat_at,last_step")
    .in("type", types)
    .eq("status", "queued")
    .is("claimed_by", null)
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
    .select("id,type,status,payload,attempts,claimed_by,claimed_at,heartbeat_at,last_step,last_error")
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

// ---------- intent/trade helpers ----------
async function fetchIntent(intentId) {
  const { data, error } = await sb
    .from("execution_intents")
    .select("id,action,symbol,status,reason,execution_mode,raw_signal,created_at")
    .eq("id", intentId)
    .limit(1);

  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

function extractTradeId(intent) {
  const rs = intent && intent.raw_signal ? intent.raw_signal : null;
  if (!rs || typeof rs !== "object") return null;
  // tolerate naming differences
  return (
    rs.trade_id ||
    rs.tradeId ||
    rs.tradeID ||
    rs.position_id ||
    rs.positionId ||
    null
  );
}

async function isTradeStillOpen(tradeId) {
  if (!tradeId) return null; // unknown
  const { data, error } = await sb
    .from("trades_prod")
    .select("id,status,closed_at")
    .eq("id", tradeId)
    .limit(1);

  if (error) throw error;
  if (!data || !data[0]) return null;
  const row = data[0];
  return String(row.status || "").toLowerCase() === "open";
}

// ---------- webhook execution ----------
async function executeViaWebhook(job) {
  if (!hasWebhook) {
    return { ok: false, code: "missing_webhook_url", detail: "WORKER_WEBHOOK_URL not set" };
  }

  const p = job.payload || {};
  const intentId = p.intent_id || p.intentId || p.intent || null;
  const action = p.action || null;
  const symbol = p.symbol || null;

  // Pull authoritative intent details (so we can provide trade_id + normalized fields)
  let intent = null;
  if (intentId) {
    intent = await fetchIntent(intentId);
  }

  const effectiveAction = (intent && intent.action) ? intent.action : action;
  const effectiveSymbol = (intent && intent.symbol) ? intent.symbol : symbol;
  const executionMode = (intent && intent.execution_mode) ? intent.execution_mode : (p.execution_mode || p.mode || "paper");
  const tradeId = extractTradeId(intent) || p.trade_id || p.tradeId || null;

  // 🔥 Critical: flatten fields for ladder-bot compatibility
  // Keep payload nested too, for backward compatibility / debugging.
  const body = {
    // expected by most ladder-bot implementations
    action: effectiveAction,
    symbol: effectiveSymbol,
    intent_id: intentId,

    // required for reliable paper closes
    trade_id: tradeId,
    execution_mode: executionMode,

    // tracing
    job_id: job.id,
    type: job.type,
    worker_id: WORKER_ID,
    ts: nowIso(),

    // keep original payload for compatibility
    payload: job.payload || {},
    intent_snapshot: intent ? { id: intent.id, status: intent.status, reason: intent.reason, created_at: intent.created_at } : null,
  };

  const headers = {
    "content-type": "application/json",
  };

  if (hasApiSecret) {
    headers["x-api-secret"] = API_SECRET;
    headers["x-api-key"] = API_SECRET;
    headers["authorization"] = `Bearer ${API_SECRET}`;
  }

  const res = await fetchWithTimeout(
    WORKER_WEBHOOK_URL,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    JOB_TIMEOUT_MS
  );

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return {
      ok: false,
      code: `webhook_failed_http_${res.status}`,
      detail: text.slice(0, 500),
      meta: { action: effectiveAction, symbol: effectiveSymbol, intent_id: intentId, trade_id: tradeId },
    };
  }

  // Post-check: for exits, ensure trade actually closes (prevents silent no-op completes)
  if (isExitAction(effectiveAction) && tradeId) {
    // small delay to allow ladder-bot to write trade update/execution rows
    await sleep(400);

    const stillOpen = await isTradeStillOpen(tradeId);
    if (stillOpen === true) {
      return {
        ok: false,
        code: "postcheck_trade_still_open",
        detail: `Exit webhook returned 200 but trade still open: ${tradeId}`,
        meta: { action: effectiveAction, symbol: effectiveSymbol, intent_id: intentId, trade_id: tradeId },
      };
    }
  }

  return { ok: true, code: "ok", detail: text.slice(0, 500) };
}

// ---------- main loop ----------
async function loop() {
  while (true) {
    try {
      log({ tag: TAG, msg: "POLL", ts: nowIso(), types: TYPES });

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
        last_step: claimed.last_step,
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
          meta: result.meta || null,
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
