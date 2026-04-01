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
 *  - TYPES (e.g. "execute_intent" or JSON '[\"execute_intent\"]')
 *  - POLL_MS (default 2000)
 *  - JOB_TIMEOUT_MS (default 60000)
 *  - JOB_HEARTBEAT_MS (default 15000)
 *  - WORKER_WEBHOOK_URL (e.g. https://ladder-bot-production.up.railway.app/webhook/worker)
 *  - API_SECRET (must match ladder-bot API_SECRET)
 *
 * Optional:
 *  - MAX_ATTEMPTS (default 3)
 *  - RETRY_BACKOFF_MS (default 5000)
 *  - SELFHEAL_DEADLETTER (default 1)
 *  - SELFHEAL_BATCH (default 25)
 *
 * Option 1 (Institutional fix for CLOSE ledger):
 *  - After a successful webhook execution of a CLOSE intent, this worker writes the append-only
 *    close row into trade_executions_prod (intent_id required), so existing DB triggers can
 *    finalize the trade.
 *  - This keeps Supabase as sovereign authority and respects append-only constraints.
 *
 * Alpha policy preflight:
 *  - Entry intents are preflight-checked against public.alpha_decision_policy_v2
 *  - If policy says FLAT_ONLY / TIER_0 / wrong side, worker classifies job as cancelled
 *  - Exits / closes always bypass policy preflight
 *
 * Strategic note:
 *  - Paper mode is validation.
 *  - Live money is the destination.
 *  - This patch keeps policy enforcement reusable for both paper and future live execution.
 */

const { createClient } = require("@supabase/supabase-js");
const { randomUUID } = require("crypto");

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
function isEntryAction(action) {
  const a = String(action || "").toLowerCase();
  return a === "buy" || a === "long" || a === "sell" || a === "short";
}
function isPaperLikeMode(mode) {
  const m = String(mode || "").toLowerCase();
  return m === "paper" || m === "paper_real_price" || m === "";
}
function isLiveLikeMode(mode) {
  return String(mode || "").toLowerCase() === "live";
}
function msBackoff(baseMs, attempts) {
  const n = Math.max(1, Number(attempts || 0) + 1);
  return baseMs * n;
}
function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normalizePairFromSymbol(s) {
  const sym = safeTrim(s);
  if (!sym) return null;
  if (sym.includes("-")) return sym;
  return `${sym}-USDC`;
}
function normalizePolicySymbol(payload, intent) {
  return (
    safeTrim(payload?.pair) ||
    normalizePairFromSymbol(payload?.symbol || (intent ? intent.symbol : null)) ||
    null
  );
}
function normalizeIntentSide(action) {
  const a = String(action || "").toLowerCase();
  if (a === "buy" || a === "long") return "LONG";
  if (a === "sell" || a === "short") return "SHORT";
  return "UNKNOWN";
}
function summarizeUnknownError(err) {
  return {
    error_message: err && err.message ? err.message : String(err),
    error_name: err && err.name ? err.name : null,
    error_code: err && err.code ? err.code : null,
    error_details: err && err.details ? err.details : null,
    error_hint: err && err.hint ? err.hint : null,
    error_stack: err && err.stack ? err.stack : null,
    error_json: (() => {
      try {
        return JSON.stringify(err);
      } catch {
        return null;
      }
    })(),
  };
}
function getLiveCloseConfirmationState(result, claimed) {
  const payload = claimed && claimed.payload ? claimed.payload : {};
  const action = safeTrim(payload.action);
  const execMode = safeTrim(payload.execution_mode || payload.mode);
  const response = result && result.response ? result.response : {};
  const liveClose = isExitAction(action) && isLiveLikeMode(execMode);

  if (!liveClose) return { liveClose: false, confirmed: true, code: "not_live_close" };

  const closeValidation = safeTrim(
    response.close_validation ||
    response.closeValidation ||
    response.validation ||
    response.data?.close_validation ||
    response.data?.closeValidation
  ).toLowerCase();

  const confirmedOrderId = safeTrim(
    response.confirmed_order_id ||
    response.confirmedOrderId ||
    response.order_id ||
    response.orderId ||
    response.data?.confirmed_order_id ||
    response.data?.confirmedOrderId ||
    response.data?.order_id ||
    response.data?.orderId
  );

  const pendingConfirmation =
    response.pending_confirmation === true ||
    response.pendingConfirmation === true ||
    response.pending === true ||
    response.awaiting_confirmation === true;

  const flatConfirmed =
    response.flat_confirmed === true ||
    response.coinbase_flat_confirmed === true ||
    response.data?.flat_confirmed === true ||
    response.data?.coinbase_flat_confirmed === true;

  const brokerConfirmed = closeValidation === "broker_order_confirmed";
  const coinbaseFlatConfirmed = closeValidation === "coinbase_flat_confirmed" || flatConfirmed;
  const confirmed =
    brokerConfirmed ||
    coinbaseFlatConfirmed ||
    (confirmedOrderId && !/^CST_/i.test(confirmedOrderId));

  if (confirmed) {
    return {
      liveClose: true,
      confirmed: true,
      code: brokerConfirmed ? "broker_order_confirmed" : "coinbase_flat_confirmed",
      closeValidation: closeValidation || null,
      confirmedOrderId: confirmedOrderId || null,
    };
  }
  if (pendingConfirmation) {
    return {
      liveClose: true,
      confirmed: false,
      code: "live_close_pending_confirmation",
      closeValidation: closeValidation || null,
      confirmedOrderId: null,
    };
  }
  return {
    liveClose: true,
    confirmed: false,
    code: "live_close_unconfirmed",
    closeValidation: closeValidation || null,
    confirmedOrderId: null,
  };
}

// ---------- config ----------
const TAG = "AUX";
const WORKER_ENABLED = envBool("WORKER_ENABLED", true);
const WORKER_ID = process.env.WORKER_ID || "ladder-worker-1";
const TYPES = parseTypes(process.env.TYPES || process.env.WORKER_TYPES || "execute_intent");
const POLL_MS = envInt("POLL_MS", 2000);
const JOB_TIMEOUT_MS = envInt("JOB_TIMEOUT_MS", 60000);
const JOB_HEARTBEAT_MS = envInt("JOB_HEARTBEAT_MS", 15000);

const MAX_ATTEMPTS = envInt("MAX_ATTEMPTS", 3);
const RETRY_BACKOFF_MS = envInt("RETRY_BACKOFF_MS", 5000);

const SELFHEAL_DEADLETTER = envBool("SELFHEAL_DEADLETTER", true);
const SELFHEAL_BATCH = envInt("SELFHEAL_BATCH", 25);

const CLOSE_LEDGER_ENABLED = envBool("CLOSE_LEDGER_ENABLED", true);
const CLOSE_LEDGER_ASSUME_BOT_WRITES = envBool("CLOSE_LEDGER_ASSUME_BOT_WRITES", false);

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
  JOB_HEARTBEAT_MS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  SELFHEAL_DEADLETTER,
  SELFHEAL_BATCH,
  CLOSE_LEDGER_ENABLED,
  CLOSE_LEDGER_ASSUME_BOT_WRITES,
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

// ---------- job lifecycle helpers ----------
async function touchHeartbeat(jobId, step = "processing") {
  const { error } = await sb
    .from("execution_jobs")
    .update({
      heartbeat_at: nowIso(),
      last_step: step,
    })
    .eq("id", jobId)
    .eq("claimed_by", WORKER_ID)
    .eq("status", "running");

  if (error) throw error;
}
function startHeartbeat(jobId, intervalMs = JOB_HEARTBEAT_MS) {
  const timer = setInterval(() => {
    touchHeartbeat(jobId, "processing").catch((err) => {
      log({
        tag: TAG,
        msg: "HEARTBEAT_ERROR",
        ts: nowIso(),
        job_id: jobId,
        error: String(err && err.message ? err.message : err),
      });
    });
  }, intervalMs);
  return () => clearInterval(timer);
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
async function cancelJobSkipped(jobId, step, note) {
  const now = nowIso();
  const { error } = await sb
    .from("execution_jobs")
    .update({
      status: "cancelled",
      heartbeat_at: now,
      last_step: step || "policy_cancelled",
      last_error: note || null,
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

// ---------- core DB ops ----------
async function pickQueuedJob(types) {
  const now = nowIso();
  const { data, error } = await sb
    .from("execution_jobs")
    .select("id,type,status,payload,attempts,created_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id")
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
    .select("id,type,status,payload,attempts,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id")
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

// ---------- webhook execution ----------
async function executeViaWebhook(job) {
  if (!hasWebhook) return { ok: false, code: "missing_webhook_url", detail: "WORKER_WEBHOOK_URL not set" };

  const payload = {
    ...(job.payload || {}),
    intent_id: safeTrim(job.intent_id || job.payload?.intent_id || job.payload?.intentId),
  };

  const body = {
    job_id: job.id,
    type: job.type,
    payload,
    intent_id: payload.intent_id || null,
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
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_) {}

  if (!res.ok) {
    return {
      ok: false,
      code: `webhook_failed_http_${res.status}`,
      detail: text.slice(0, 500),
      response: parsed,
      http_status: res.status,
    };
  }

  if (parsed && parsed.ok === false) {
    return {
      ok: false,
      code: parsed.error || parsed.reason || "webhook_returned_ok_false",
      detail: text.slice(0, 500),
      response: parsed,
      http_status: res.status,
    };
  }

  return {
    ok: true,
    code: "ok",
    detail: text.slice(0, 500),
    response: parsed,
    http_status: res.status,
  };
}

// ---------- intent / policy helpers ----------
async function fetchIntent(intentId) {
  if (!intentId) return null;
  const { data, error } = await sb
    .from("execution_intents")
    .select("id,raw_signal,action,symbol,execution_mode")
    .eq("id", intentId)
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function fetchAlphaDecisionPolicy(symbol) {
  const { data, error } = await sb
    .from("alpha_decision_policy_v2")
    .select("*")
    .eq("symbol", symbol)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}
async function policyPreflight(job) {
  if (!job || job.type !== "execute_intent") return { allow: true, code: "not_execute_intent" };

  const payload = job.payload || {};
  const action = safeTrim(payload.action);

  if (isExitAction(action)) return { allow: true, code: "exit_bypass" };
  if (!isEntryAction(action)) return { allow: true, code: "unknown_action_bypass" };

  const intent = await fetchIntent(job.intent_id).catch(() => null);
  const symbol = normalizePolicySymbol(payload, intent);
  if (!symbol) return { allow: true, code: "missing_symbol_bypass" };

  const policy = await fetchAlphaDecisionPolicy(symbol);
  if (!policy) return { allow: true, code: "policy_missing_bypass", symbol };

  const side = normalizeIntentSide(action);
  const sidePermission = safeTrim(policy.side_permission).toUpperCase();
  const sizeTier = safeTrim(policy.size_tier).toUpperCase();

  if (sidePermission === "FLAT_ONLY" || sizeTier === "TIER_0") {
    return { allow: false, code: "symbol_not_allowed", symbol, policy };
  }
  if (side === "LONG" && sidePermission !== "LONG_ONLY") {
    return { allow: false, code: "symbol_not_allowed", symbol, policy };
  }
  if (side === "SHORT" && sidePermission !== "SHORT_ONLY") {
    return { allow: false, code: "symbol_not_allowed", symbol, policy };
  }
  return { allow: true, code: "policy_allow", symbol, policy };
}

// ---------- Option 1: CLOSE ledger writer (append-only) ----------
async function findOpenPaperTradeByPair(pair) {
  if (!pair) return null;
  const { data, error } = await sb
    .from("trades_prod")
    .select("id,amount,qty_base,entry_price,status,metadata,created_at")
    .eq("symbol", pair)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;

  const rows = data || [];
  for (const r of rows) {
    const mode = r.metadata && (r.metadata.mode || r.metadata["mode"])
      ? String(r.metadata.mode || r.metadata["mode"])
      : "";
    if (isPaperLikeMode(mode)) return r;
  }
  return rows[0] || null;
}
async function getTradeAmount(tradeId, tradeRowMaybe) {
  if (tradeRowMaybe && tradeRowMaybe.amount != null) {
    const n = toNum(tradeRowMaybe.amount);
    if (n && n > 0) return n;
  }
  const { data, error } = await sb
    .from("trade_executions_prod")
    .select("amount,execution_type")
    .eq("trade_id", tradeId)
    .eq("execution_type", "fill")
    .order("executed_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  let sum = 0;
  for (const f of data || []) {
    const n = toNum(f.amount);
    if (n && n > 0) sum += n;
  }
  return sum > 0 ? sum : 50;
}
async function getTradeQtyBase(tradeId, tradeRowMaybe) {
  if (tradeRowMaybe && tradeRowMaybe.qty_base != null) {
    const n = toNum(tradeRowMaybe.qty_base);
    if (n && n > 0) return n;
  }
  const { data, error } = await sb
    .from("trade_executions_prod")
    .select("qty_base,execution_type")
    .eq("trade_id", tradeId)
    .eq("execution_type", "fill")
    .order("executed_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  let sum = 0;
  for (const f of data || []) {
    const n = toNum(f.qty_base);
    if (n && n > 0) sum += n;
  }
  return sum > 0 ? sum : null;
}
async function hasAnyFill(tradeId) {
  const { data, error } = await sb
    .from("trade_executions_prod")
    .select("id")
    .eq("trade_id", tradeId)
    .eq("execution_type", "fill")
    .limit(1);
  if (error) throw error;
  return Boolean(data && data[0]);
}
async function getPriceFromMarketMarks(pair) {
  if (!pair) return null;
  const { data, error } = await sb
    .from("market_marks")
    .select("price,marked_at")
    .eq("symbol", pair)
    .order("marked_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? toNum(data[0].price) : null;
}
async function getLastFillPrice(tradeId) {
  const { data, error } = await sb
    .from("trade_executions_prod")
    .select("price,executed_at")
    .eq("trade_id", tradeId)
    .eq("execution_type", "fill")
    .order("executed_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? toNum(data[0].price) : null;
}
async function closeAlreadyWrittenForIntent(intentId) {
  const { data, error } = await sb
    .from("trade_executions_prod")
    .select("id")
    .eq("intent_id", intentId)
    .eq("execution_type", "close")
    .limit(1);
  if (error) throw error;
  return Boolean(data && data[0]);
}
async function writeCloseLedgerRow({ job, intentId, tradeId, pair, amount, qtyBase, price, priceSource, mode }) {
  const execId = randomUUID();
  const row = {
    id: execId,
    trade_id: tradeId,
    intent_id: intentId,
    execution_type: "close",
    executed_at: nowIso(),
    price: price,
    amount: amount,
    qty_base: qtyBase,
    fee: 0,
    fee_currency: "USD",
    exchange: "paper",
    metadata: {
      source: "worker_close_ledger",
      job_id: String(job.id),
      pair,
      price_source: priceSource,
      mode,
      worker_id: WORKER_ID,
    },
    created_at: nowIso(),
  };
  const { error } = await sb.from("trade_executions_prod").insert(row);
  if (error) throw error;
  return execId;
}
async function ensureCloseLedgerForJob({ job }) {
  try {
    if (!CLOSE_LEDGER_ENABLED) return { ok: true, did: false, code: "disabled" };
    if (CLOSE_LEDGER_ASSUME_BOT_WRITES) return { ok: true, did: false, code: "assume_bot_writes" };
    if (!job || job.type !== "execute_intent") return { ok: true, did: false, code: "not_execute_intent" };

    const payload = job.payload || {};
    const action = safeTrim(payload.action);
    if (!isExitAction(action)) return { ok: true, did: false, code: "not_close" };

    const intentId = safeTrim(job.intent_id || payload.intent_id || payload.intentId);
    if (!intentId) return { ok: false, did: false, code: "close_ledger_missing_intent_id", detail: "job.intent_id missing" };

    if (await closeAlreadyWrittenForIntent(intentId)) return { ok: true, did: false, code: "close_already_written" };

    const intent = await fetchIntent(intentId).catch(() => null);
    const pair =
      safeTrim(payload.pair) ||
      safeTrim(intent && intent.raw_signal ? intent.raw_signal.pair || intent.raw_signal["pair"] : "") ||
      normalizePairFromSymbol(payload.symbol || (intent ? intent.symbol : null));
    const mode =
      safeTrim(payload.execution_mode) ||
      safeTrim(intent ? intent.execution_mode : "") ||
      "paper";

    if (isLiveLikeMode(mode)) return { ok: true, did: false, code: "live_close_ledger_skipped" };

    let tradeId =
      safeTrim(payload.trade_id) ||
      safeTrim(intent && intent.raw_signal ? intent.raw_signal.trade_id || intent.raw_signal["trade_id"] : "");

    let tradeRow = null;
    if (!tradeId) {
      tradeRow = await findOpenPaperTradeByPair(pair);
      tradeId = tradeRow ? tradeRow.id : null;
    } else {
      const { data, error } = await sb
        .from("trades_prod")
        .select("id,amount,qty_base,entry_price,metadata,status,created_at")
        .eq("id", tradeId)
        .limit(1);
      if (error) throw error;
      tradeRow = data && data[0] ? data[0] : null;
    }

    if (!tradeId) return { ok: false, did: false, code: "close_ledger_no_trade_found", detail: `pair=${pair || "(null)"}` };

    const tradeMode = tradeRow && tradeRow.metadata && tradeRow.metadata.mode
      ? String(tradeRow.metadata.mode)
      : mode;

    const hasFill = await hasAnyFill(tradeId);
    if (!hasFill && !isPaperLikeMode(tradeMode)) {
      return { ok: false, did: false, code: "close_ledger_missing_fill", detail: `trade_id=${tradeId}` };
    }

    const amount = await getTradeAmount(tradeId, tradeRow);
    const qtyBase = await getTradeQtyBase(tradeId, tradeRow);
    const priceMarks = await getPriceFromMarketMarks(pair);
    const priceLastFill = await getLastFillPrice(tradeId);

    const price = priceMarks != null ? priceMarks : priceLastFill;
    const priceSource = priceMarks != null ? "market_marks" : priceLastFill != null ? "last_fill" : null;

    if (price == null) {
      return { ok: false, did: false, code: "close_ledger_missing_price", detail: `pair=${pair} trade_id=${tradeId}` };
    }

    const execId = await writeCloseLedgerRow({ job, intentId, tradeId, pair, amount, qtyBase, price, priceSource, mode: tradeMode });

    log({
      tag: TAG,
      msg: "CLOSE_LEDGER_WRITTEN",
      ts: nowIso(),
      job_id: job.id,
      intent_id: intentId,
      trade_id: tradeId,
      exec_id: execId,
      pair,
      price,
      amount,
      qty_base: qtyBase,
      price_source: priceSource,
      trade_mode: tradeMode,
    });

    return { ok: true, did: true, code: "close_ledger_written", exec_id: execId };
  } catch (err) {
    return {
      ok: false,
      did: false,
      code: "close_ledger_exception",
      detail: String(err && err.message ? err.message : err),
    };
  }
}

// ---------- selfheal helpers ----------
function toPairFromSymbol(sym) {
  const s = safeTrim(sym);
  if (!s) return null;
  return s.includes("-") ? s : `${s}-USDC`;
}
function pickPairFromJobAndIntent(job, intent) {
  const p = job && job.payload ? job.payload : {};
  const i = intent && intent.raw_signal ? intent.raw_signal : {};
  return (
    safeTrim(p.pair) ||
    safeTrim(i.pair) ||
    safeTrim(i["pair"]) ||
    (p.symbol ? toPairFromSymbol(p.symbol) : null) ||
    (intent && intent.symbol ? toPairFromSymbol(intent.symbol) : null) ||
    null
  );
}
async function resolveOpenPaperTradeIdByPair(pair) {
  const pr = safeTrim(pair);
  if (!pr) return null;
  const { data, error } = await sb
    .from("trades_prod")
    .select("id,status,metadata,created_at")
    .eq("status", "open")
    .eq("symbol", pr)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  for (const row of data || []) {
    const mode = row.metadata && row.metadata.mode ? String(row.metadata.mode) : null;
    if (!isPaperLikeMode(mode)) continue;
    return row.id;
  }
  return null;
}
async function tradeIsOpen(tradeId) {
  if (!tradeId) return null;
  const { data, error } = await sb
    .from("trades_prod")
    .select("id,status,metadata")
    .eq("id", tradeId)
    .limit(1);
  if (error) throw error;
  const row = data && data[0] ? data[0] : null;
  if (!row) return null;
  const mode = row.metadata && row.metadata.mode ? String(row.metadata.mode) : null;
  if (!isPaperLikeMode(mode)) return false;
  return String(row.status || "").toLowerCase() === "open";
}
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
    .in("last_error", ["deadletter_max_attempts", "postcheck_trade_still_open", "live_close_pending_confirmation", "live_close_unconfirmed"])
    .order("created_at", { ascending: true })
    .limit(batch);
  if (error) throw error;
  if (!dead || dead.length === 0) return 0;

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

    let tradeId =
      (j.payload && j.payload.trade_id) ||
      (intent && intent.raw_signal ? intent.raw_signal.trade_id || intent.raw_signal["trade_id"] : null);
    const pair = pickPairFromJobAndIntent(j, intent);

    if (!tradeId && pair) tradeId = await resolveOpenPaperTradeIdByPair(pair);

    const open = await tradeIsOpen(tradeId);
    if (open !== true) continue;

    await selfhealRequeueSameJob(j, {
      action,
      symbol: (j.payload && j.payload.symbol) || (intent ? intent.symbol : null),
      pair,
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

      log({ tag: TAG, msg: "STEP_START", ts: nowIso(), step: "selfhealDeadletters", batch: SELFHEAL_BATCH });
      const selfhealCount = await selfhealDeadletters(SELFHEAL_BATCH);
      log({ tag: TAG, msg: "STEP_OK", ts: nowIso(), step: "selfhealDeadletters", requeued: selfhealCount });

      log({ tag: TAG, msg: "STEP_START", ts: nowIso(), step: "pickQueuedJob", types: TYPES });
      const candidate = await pickQueuedJob(TYPES);
      log({
        tag: TAG, msg: "STEP_OK", ts: nowIso(), step: "pickQueuedJob",
        found: Boolean(candidate), candidate_id: candidate ? candidate.id : null,
        candidate_type: candidate ? candidate.type : null, candidate_intent_id: candidate ? candidate.intent_id : null,
      });

      if (!candidate) {
        await sleep(POLL_MS);
        continue;
      }

      log({ tag: TAG, msg: "STEP_START", ts: nowIso(), step: "claimJob", candidate_id: candidate.id });
      const claimed = await claimJob(candidate.id);
      log({
        tag: TAG, msg: "STEP_OK", ts: nowIso(), step: "claimJob",
        claimed: Boolean(claimed), claimed_id: claimed ? claimed.id : null,
        claimed_type: claimed ? claimed.type : null, claimed_intent_id: claimed ? claimed.intent_id : null,
      });

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
        attempts: claimed.attempts,
      });

      await touchHeartbeat(claimed.id, "policy_preflight");
      const preflight = await policyPreflight(claimed);

      if (!preflight.allow) {
        await cancelJobSkipped(claimed.id, `policy_cancelled_${preflight.code}`, preflight.code);
        log({
          tag: TAG,
          msg: "JOB_POLICY_CANCELLED",
          ts: nowIso(),
          id: claimed.id,
          type: claimed.type,
          intent_id: claimed.intent_id,
          symbol: preflight.symbol || null,
          code: preflight.code,
          side_permission: preflight.policy?.side_permission || null,
          size_tier: preflight.policy?.size_tier || null,
          policy_reason: preflight.policy?.policy_reason || null,
          direction_score: preflight.policy?.direction_score || null,
          permission_score: preflight.policy?.permission_score || null,
        });
        await sleep(250);
        continue;
      }

      await touchHeartbeat(claimed.id, "webhook_dispatch");
      const stopHeartbeat = startHeartbeat(claimed.id, JOB_HEARTBEAT_MS);

      let result;
      try {
        result = await executeViaWebhook(claimed);
      } finally {
        stopHeartbeat();
      }

      if (result.ok) {
        const closeConfirm = getLiveCloseConfirmationState(result, claimed);

        log({
          tag: TAG,
          msg: "WEBHOOK_OK",
          ts: nowIso(),
          id: claimed.id,
          type: claimed.type,
          intent_id: claimed.intent_id,
          http_status: result.http_status || null,
          response_ok: result.response?.ok ?? true,
          response_error: result.response?.error || null,
          order_id: result.response?.order_id || null,
          action: result.response?.action || claimed.payload?.action || null,
          mode: result.response?.mode || claimed.payload?.execution_mode || null,
          live_close_confirmed: closeConfirm.liveClose ? closeConfirm.confirmed : null,
          live_close_code: closeConfirm.liveClose ? closeConfirm.code : null,
        });

        if (closeConfirm.liveClose && !closeConfirm.confirmed) {
          const attempts = Number(claimed.attempts || 0);
          const errCode = closeConfirm.code || "live_close_unconfirmed";
          if (attempts + 1 >= MAX_ATTEMPTS) {
            await markFailedDeadletter(claimed.id, "deadletter_max_attempts");
            log({
              tag: TAG,
              msg: "JOB_DEADLETTERED_LIVE_CLOSE_PENDING",
              ts: nowIso(),
              id: claimed.id,
              type: claimed.type,
              last_error: errCode,
            });
          } else {
            await requeueWithBackoff(claimed, errCode);
            log({
              tag: TAG,
              msg: "JOB_LIVE_CLOSE_PENDING_RETRYING",
              ts: nowIso(),
              id: claimed.id,
              type: claimed.type,
              last_error: errCode,
            });
          }
          await sleep(250);
          continue;
        }

        await touchHeartbeat(claimed.id, "close_ledger");
        const ledger = await ensureCloseLedgerForJob({ job: claimed, result });

        if (!ledger.ok) {
          const attempts = Number(claimed.attempts || 0);
          const errCode = ledger.code || "close_ledger_failed";
          if (attempts + 1 >= MAX_ATTEMPTS) {
            await markFailedDeadletter(claimed.id, "deadletter_max_attempts");
            log({
              tag: TAG,
              msg: "JOB_DEADLETTERED_CLOSE_LEDGER",
              ts: nowIso(),
              id: claimed.id,
              type: claimed.type,
              last_error: errCode,
              detail: ledger.detail,
            });
          } else {
            await requeueWithBackoff(claimed, errCode);
            log({
              tag: TAG,
              msg: "JOB_CLOSE_LEDGER_FAILED_RETRYING",
              ts: nowIso(),
              id: claimed.id,
              type: claimed.type,
              last_error: errCode,
              detail: ledger.detail,
            });
          }
          await sleep(250);
          continue;
        }

        await touchHeartbeat(claimed.id, "finalizing");
        await completeJob(claimed.id);

        log({
          tag: TAG,
          msg: "JOB_COMPLETED",
          ts: nowIso(),
          id: claimed.id,
          type: claimed.type,
          close_ledger: ledger.code,
          live_close_confirmed: closeConfirm.liveClose ? closeConfirm.confirmed : null,
          live_close_code: closeConfirm.liveClose ? closeConfirm.code : null,
        });
      } else {
        const attempts = Number(claimed.attempts || 0);
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
        ...summarizeUnknownError(err),
      });
      await sleep(Math.max(1000, POLL_MS));
    }
  }
}

loop();
