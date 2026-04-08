/**
 * worker.js (CommonJS)
 * Production-safe execution worker for Railway + Supabase.
 *
 * Core job:
 *  - claim execution_jobs(status='queued') where:
 *      - claimed_by is null
 *      - run_at is null OR run_at <= now()
 *  - execute directly against Coinbase layer (no internal webhook relay)
 *
 * Critical live-close rule:
 *  - LIVE close jobs MUST NEVER write fallback/paper close ledger rows.
 *  - A live close job is only completed when execution confirms the exchange close.
 *  - If confirmation is missing, the job is retried/deadlettered with
 *    live_close_unconfirmed or live_close_pending_confirmation.
 *
 * Paper/legacy close rule:
 *  - Non-live close jobs may still use DB close-ledger fallback when enabled.
 *
 * Idempotency safety fix (FIXED_POLICY_V3_DIRECT_RESOLVER):
 *  - If direct execution already produced a trade/execution
 *    for the same intent_id, the worker treats that as already executed and completes
 *    the job instead of deadlettering a false failure.
 *  - Coinbase execution module is loaded through a safe resolver so Railway path/name
 *    mismatches are surfaced clearly in logs.
 */

const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

function loadCoinbaseExecution() {
  const candidates = [
    './coinbase_execution.js',
    './coinbase_execution',
    './coinbase-execution.js',
    './coinbase-execution',
    './lib/coinbase_execution.js',
    './lib/coinbase_execution',
    './lib/coinbase-execution.js',
    './lib/coinbase-execution',
    '/app/coinbase_execution.js',
    '/app/coinbase_execution',
    '/app/coinbase-execution.js',
    '/app/coinbase-execution'
  ];

  for (const candidate of candidates) {
    try {
      const resolved = path.isAbsolute(candidate)
        ? candidate
        : path.resolve(__dirname, candidate);

      if (!fs.existsSync(resolved)) continue;

      const mod = require(resolved);
      if (mod && typeof mod.executeTrade === 'function') {
        console.log(`[WORKER] Loaded Coinbase execution module from: ${resolved}`);
        return mod;
      }
    } catch (err) {
      console.error(`[WORKER] Coinbase module candidate failed: ${candidate} :: ${err.message}`);
    }
  }

  const files = fs.readdirSync(__dirname);
  throw new Error(
    `[WORKER] Coinbase execution module not found. __dirname=${__dirname}. Files in dir: ${files.join(', ')}`
  );
}

const { executeTrade } = loadCoinbaseExecution();

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
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}
function envInt(name, fallback) {
  const n = parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}
function safeTrim(v) {
  return String(v || '').trim();
}
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function msBackoff(baseMs, attempts) {
  const n = Math.max(1, Number(attempts || 0) + 1);
  return baseMs * n;
}
function parseTypes(raw) {
  if (!raw) return ['execute_intent'];
  const s = String(raw).trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr.length) return arr.map(String);
    } catch (_) {}
  }
  return s.split(/[\s,]+/g).map((x) => x.trim()).filter(Boolean);
}
function normalizePairFromSymbol(s) {
  const sym = safeTrim(s);
  if (!sym) return null;
  return sym.includes('-') ? sym.toUpperCase() : `${sym.toUpperCase()}-USDC`;
}
function normalizePolicySymbol(payload, intent) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const i = intent && typeof intent === 'object' ? intent : {};
  const raw = i.raw_signal && typeof i.raw_signal === 'object' ? i.raw_signal : {};

  const symbol =
    safeTrim(p.symbol) ||
    safeTrim(p.pair) ||
    safeTrim(raw.symbol) ||
    safeTrim(raw.pair) ||
    safeTrim(i.symbol);

  if (!symbol) return null;
  return symbol.includes('-') ? symbol.toUpperCase() : `${symbol.toUpperCase()}-USDC`;
}
function normalizeIntentSide(action) {
  const a = safeTrim(action).toLowerCase();
  if (a === 'buy') return 'LONG';
  if (a === 'sell' || a === 'close' || a === 'exit') return 'SHORT';
  return 'UNKNOWN';
}
function isExitAction(action) {
  const a = String(action || '').trim().toLowerCase();
  return a === 'close' || a === 'exit' || a === 'sell';
}
function isPaperLikeMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  return m === '' || m === 'paper' || m === 'paper_real_price';
}
function isLiveLikeMode(mode) {
  return String(mode || '').trim().toLowerCase() === 'live';
}
function summarizeUnknownError(err) {
  return {
    error_message: err && err.message ? err.message : String(err),
    error_name: err && err.name ? err.name : null,
    error_code: err && err.code ? err.code : null,
    error_details: err && err.details ? err.details : null,
    error_hint: err && err.hint ? err.hint : null,
    error_stack: err && err.stack ? err.stack : null,
  };
}

function getLiveCloseConfirmationState(result, claimed) {
  const payload = claimed && claimed.payload ? claimed.payload : {};
  const action = safeTrim(payload.action);
  const execMode = safeTrim(payload.execution_mode || payload.mode);
  const response = result && result.response ? result.response : {};
  const liveClose = isExitAction(action) && isLiveLikeMode(execMode);

  if (!liveClose) return { liveClose: false, confirmed: true, code: 'not_live_close' };

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

  const brokerConfirmed = closeValidation === 'broker_order_confirmed';
  const coinbaseFlatConfirmed = closeValidation === 'coinbase_flat_confirmed' || flatConfirmed;
  const confirmed =
    brokerConfirmed ||
    coinbaseFlatConfirmed ||
    (confirmedOrderId && !/^CST_/i.test(confirmedOrderId));

  if (confirmed) {
    return {
      liveClose: true,
      confirmed: true,
      code: brokerConfirmed ? 'broker_order_confirmed' : 'coinbase_flat_confirmed',
      closeValidation: closeValidation || null,
      confirmedOrderId: confirmedOrderId || null,
    };
  }
  if (pendingConfirmation) {
    return {
      liveClose: true,
      confirmed: false,
      code: 'live_close_pending_confirmation',
      closeValidation: closeValidation || null,
      confirmedOrderId: null,
    };
  }
  return {
    liveClose: true,
    confirmed: false,
    code: 'live_close_unconfirmed',
    closeValidation: closeValidation || null,
    confirmedOrderId: null,
  };
}

function isLiveCloseJob(job) {
  const payload = job && job.payload && typeof job.payload === 'object' ? job.payload : {};
  const action = String(payload.action || '').trim().toLowerCase();
  const raw = payload.raw_signal && typeof payload.raw_signal === 'object' ? payload.raw_signal : {};
  const executionMode = String(
    payload.execution_mode || payload.mode || raw.execution_mode || raw.mode || ''
  ).trim().toLowerCase();

  const closeLike =
    action === 'close' ||
    action === 'exit' ||
    (action === 'sell' && (
      raw._is_close_intent === true ||
      String(raw.intent_kind || '').trim().toLowerCase() === 'close_trade' ||
      !!(payload.trade_id || raw.trade_id)
    ));

  return executionMode === 'live' && closeLike;
}

// ---------- config ----------
const TAG = 'AUX';
const WORKER_ENABLED = envBool('WORKER_ENABLED', true);
const WORKER_ID = process.env.WORKER_ID || 'ladder-worker-1';
const TYPES = parseTypes(process.env.TYPES || process.env.WORKER_TYPES || 'execute_intent');
const POLL_MS = envInt('POLL_MS', 2000);
const JOB_HEARTBEAT_MS = envInt('JOB_HEARTBEAT_MS', 15000);
const MAX_ATTEMPTS = envInt('MAX_ATTEMPTS', 3);
const RETRY_BACKOFF_MS = envInt('RETRY_BACKOFF_MS', 5000);
const SELFHEAL_DEADLETTER = envBool('SELFHEAL_DEADLETTER', true);
const SELFHEAL_BATCH = envInt('SELFHEAL_BATCH', 25);
const CLOSE_LEDGER_ENABLED = envBool('CLOSE_LEDGER_ENABLED', true);
const CLOSE_LEDGER_ASSUME_BOT_WRITES = envBool('CLOSE_LEDGER_ASSUME_BOT_WRITES', false);

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

log({ tag: TAG, msg: 'WORKER_VERSION_CHECK', ts: nowIso(), version: 'FIXED_POLICY_V3_DIRECT_RESOLVER' });

log({
  tag: TAG,
  msg: 'WORKER_STARTED',
  ts: nowIso(),
  WORKER_ENABLED,
  WORKER_ID,
  TYPES,
  POLL_MS,
  JOB_HEARTBEAT_MS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  SELFHEAL_DEADLETTER,
  SELFHEAL_BATCH,
  CLOSE_LEDGER_ENABLED,
  CLOSE_LEDGER_ASSUME_BOT_WRITES,
  hasSupabase,
  direct_execution: true,
});

if (!WORKER_ENABLED) {
  log({ tag: TAG, msg: 'WORKER_DISABLED_BY_ENV', ts: nowIso() });
  setTimeout(() => process.exit(0), 250);
  return;
}
if (!hasSupabase) {
  log({
    tag: TAG,
    msg: 'FATAL_MISSING_SUPABASE_ENV',
    ts: nowIso(),
    need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'],
  });
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------- lifecycle ----------
async function touchHeartbeat(jobId, step = 'processing') {
  const { error } = await sb
    .from('execution_jobs')
    .update({ heartbeat_at: nowIso(), last_step: step })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID)
    .eq('status', 'running');
  if (error) throw error;
}
function startHeartbeat(jobId, intervalMs = JOB_HEARTBEAT_MS) {
  const timer = setInterval(() => {
    touchHeartbeat(jobId, 'processing').catch((err) => {
      log({
        tag: TAG,
        msg: 'HEARTBEAT_ERROR',
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
    .from('execution_jobs')
    .update({ status: 'completed', heartbeat_at: now, last_step: 'completed' })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID);
  if (error) throw error;
}
async function cancelJobSkipped(jobId, step, note) {
  const now = nowIso();
  const { error } = await sb
    .from('execution_jobs')
    .update({
      status: 'cancelled',
      heartbeat_at: now,
      last_step: step || 'policy_cancelled',
      last_error: note || null,
    })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID);
  if (error) throw error;
}
async function markFailedDeadletter(jobId, lastErrorCode) {
  const now = nowIso();
  const { error } = await sb
    .from('execution_jobs')
    .update({
      status: 'failed',
      heartbeat_at: now,
      last_step: 'failed_deadletter',
      last_error: lastErrorCode || 'deadletter_max_attempts',
    })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID);
  if (error) throw error;
}
async function requeueWithBackoff(job, lastErrorCode) {
  const now = new Date();
  const backoffMs = msBackoff(RETRY_BACKOFF_MS, job.attempts);
  const nextRunAt = new Date(now.getTime() + backoffMs).toISOString();
  const nextAttempts = Number(job.attempts || 0) + 1;
  const { error } = await sb
    .from('execution_jobs')
    .update({
      status: 'queued',
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: now.toISOString(),
      last_step: `retry_queued_${nextAttempts}`,
      last_error: lastErrorCode || 'retry',
      attempts: nextAttempts,
      run_at: nextRunAt,
    })
    .eq('id', job.id)
    .eq('claimed_by', WORKER_ID);
  if (error) throw error;
  log({
    tag: TAG,
    msg: 'JOB_REQUEUED',
    ts: nowIso(),
    id: job.id,
    attempt: nextAttempts,
    next_run_at: nextRunAt,
    last_error: lastErrorCode,
  });
}

// ---------- job ops ----------
async function pickQueuedJob(types) {
  const now = nowIso();
  const { data, error } = await sb
    .from('execution_jobs')
    .select('id,type,status,payload,attempts,created_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id')
    .in('type', types)
    .eq('status', 'queued')
    .is('claimed_by', null)
    .or(`run_at.is.null,run_at.lte.${now}`)
    .order('run_at', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function claimJob(jobId) {
  const now = nowIso();
  const { data, error } = await sb
    .from('execution_jobs')
    .update({
      status: 'running',
      claimed_by: WORKER_ID,
      claimed_at: now,
      heartbeat_at: now,
      last_step: 'claimed',
      last_error: null,
    })
    .eq('id', jobId)
    .eq('status', 'queued')
    .is('claimed_by', null)
    .or(`run_at.is.null,run_at.lte.${now}`)
    .select('id,type,status,payload,attempts,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id')
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

// ---------- direct execution ----------
async function executeDirect(job) {
  try {
    const payload = job && job.payload && typeof job.payload === 'object' ? job.payload : {};
    const raw = payload.raw_signal && typeof payload.raw_signal === 'object' ? payload.raw_signal : {};

    const action = String(payload.action || raw.action || '').trim().toUpperCase();
    const symbol = String(payload.symbol || payload.pair || raw.symbol || raw.pair || '').trim().toUpperCase();

    if (!action) {
      return { ok: false, code: 'missing_action', detail: 'job payload missing action' };
    }
    if (!symbol) {
      return { ok: false, code: 'missing_symbol', detail: 'job payload missing symbol' };
    }

    let signalSide = action;
    if (action === 'CLOSE' || action === 'EXIT') {
      signalSide = 'SELL';
    }

    const signal = {
      symbol,
      side: signalSide,
      price: payload.price ?? raw.price ?? raw.mark_price ?? raw.entry_price ?? null,
      amount: payload.amount ?? raw.amount ?? raw._computed_amount_usd ?? raw.amount_usd ?? 50,
      qty_base: payload.qty_base ?? raw.qty_base ?? raw._computed_qty ?? null,
      mode: payload.execution_mode || payload.mode || raw.execution_mode || raw.mode || 'live',
      trade_id: payload.trade_id || raw.trade_id || null,
      reason: payload.reason || raw.reason || raw.exit_reason || null
    };

    const exec = await executeTrade(signal);

    if (!exec || exec.success !== true) {
      return {
        ok: false,
        code: exec?.error || 'direct_execution_failed',
        detail: JSON.stringify(exec || {}).slice(0, 500),
        response: exec || null
      };
    }

    return {
      ok: true,
      code: 'ok',
      http_status: 200,
      response: {
        ok: true,
        mode: 'live',
        action: signalSide,
        order_id: exec.orderId || null,
        broker_order_id: exec.brokerOrderId || null,
        client_order_id: exec.clientOrderId || null,
        fill_qty: exec.fillQty ?? null,
        fill_price: exec.fillPrice ?? exec.entryPrice ?? exec.exitPrice ?? null,
        exchange: exec.exchange || 'coinbase',
        pending_confirmation: exec.pendingFill === true,
        close_validation:
          signalSide === 'SELL'
            ? (exec.pendingFill === true ? 'client_order_only_fill_recorded' : 'broker_order_confirmed')
            : null,
        detail: exec.detail || null
      },
      detail: JSON.stringify(exec || {}).slice(0, 500)
    };
  } catch (err) {
    return {
      ok: false,
      code: 'direct_execution_exception',
      detail: err?.message || String(err)
    };
  }
}

// ---------- policy ----------
async function fetchIntent(intentId) {
  if (!intentId) return null;
  const { data, error } = await sb
    .from('execution_intents')
    .select('id,raw_signal,action,symbol,execution_mode')
    .eq('id', intentId)
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function fetchAlphaDecisionPolicy(symbol) {
  const { data, error } = await sb
    .from('alpha_decision_policy_v2')
    .select('*')
    .eq('symbol', symbol)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}
async function policyPreflight(job) {
  const payload = job && job.payload ? job.payload : {};
  const intent = await fetchIntent(job.intent_id).catch(() => null);
  const action = safeTrim(payload.action || intent?.action).toLowerCase();
  const mode = safeTrim(payload.execution_mode || intent?.execution_mode || payload.mode || 'paper').toLowerCase();

  if (!action) return { allow: false, code: 'missing_action', symbol: null, policy: null };
  if (isExitAction(action)) {
    return { allow: true, code: 'exit_bypass', symbol: normalizePolicySymbol(payload, intent), policy: null };
  }
  if (mode !== 'live') {
    return { allow: true, code: 'paper_bypass', symbol: normalizePolicySymbol(payload, intent), policy: null };
  }

  const symbol = normalizePolicySymbol(payload, intent);
  if (!symbol) return { allow: false, code: 'missing_symbol', symbol: null, policy: null };

  try {
    const policy = await fetchAlphaDecisionPolicy(symbol);
    if (!policy) return { allow: true, code: 'no_policy_row', symbol, policy: null };

    const side = normalizeIntentSide(action);
    const sizeTier = safeTrim(policy.size_tier || '').toUpperCase();
    const sidePermission = safeTrim(policy.side_permission || '').toUpperCase();

    if (sizeTier === 'TIER_0' || sidePermission === 'FLAT_ONLY') {
      return { allow: false, code: 'flat_only', symbol, policy };
    }
    if (side === 'LONG' && sidePermission.includes('SHORT')) {
      return { allow: false, code: 'wrong_side', symbol, policy };
    }
    if (side === 'SHORT' && sidePermission.includes('LONG')) {
      return { allow: false, code: 'wrong_side', symbol, policy };
    }
    return { allow: true, code: 'policy_allow', symbol, policy };
  } catch (err) {
    log({ tag: TAG, msg: 'POLICY_PREFLIGHT_ERROR', ts: nowIso(), symbol, ...summarizeUnknownError(err) });
    return { allow: true, code: 'policy_lookup_failed_allow', symbol, policy: null };
  }
}

// ---------- idempotency helpers ----------
async function findTradeForIntent(intentId) {
  if (!intentId) return null;
  const { data, error } = await sb
    .from('trades_prod')
    .select('id,status,signal_id,symbol,created_at,closed_at,metadata,close_validation,close_order_id')
    .eq('signal_id', intentId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function findExecutionForIntent(intentId) {
  if (!intentId) return null;
  const { data, error } = await sb
    .from('trade_executions_prod')
    .select('id,trade_id,intent_id,execution_type,executed_at,created_at')
    .eq('intent_id', intentId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function detectAlreadyExecutedForIntent(intentId) {
  const trade = await findTradeForIntent(intentId).catch(() => null);
  if (trade) return { alreadyExecuted: true, source: 'trades_prod', trade };
  const execution = await findExecutionForIntent(intentId).catch(() => null);
  if (execution) return { alreadyExecuted: true, source: 'trade_executions_prod', execution };
  return { alreadyExecuted: false, source: null };
}

// ---------- close ledger helpers ----------
async function closeAlreadyWrittenForIntent(intentId) {
  const { data, error } = await sb
    .from('trade_executions_prod')
    .select('id')
    .eq('intent_id', intentId)
    .eq('execution_type', 'close')
    .limit(1);
  if (error) throw error;
  return Boolean(data && data[0]);
}
async function fetchOpenTradeById(tradeId) {
  if (!tradeId) return null;
  const { data, error } = await sb
    .from('trades_prod')
    .select('id,status,amount,qty_base,entry_price,metadata,created_at,symbol')
    .eq('id', tradeId)
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function findOpenPaperTradeByPair(pair) {
  const pr = safeTrim(pair);
  if (!pr) return null;
  const { data, error } = await sb
    .from('trades_prod')
    .select('id,status,amount,qty_base,entry_price,metadata,created_at,symbol')
    .eq('status', 'open')
    .eq('symbol', pr)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  for (const row of data || []) {
    const mode = row?.metadata?.mode ? String(row.metadata.mode) : null;
    if (!isPaperLikeMode(mode)) continue;
    return row;
  }
  return null;
}
async function hasAnyFill(tradeId) {
  const { data, error } = await sb
    .from('trade_executions_prod')
    .select('id')
    .eq('trade_id', tradeId)
    .in('execution_type', ['fill', 'partial_fill'])
    .limit(1);
  if (error) throw error;
  return Boolean(data && data[0]);
}
async function getTradeAmount(tradeId, tradeRow) {
  const amt = toNum(tradeRow?.amount);
  if (amt && amt > 0) return amt;
  const { data, error } = await sb
    .from('trade_executions_prod')
    .select('amount')
    .eq('trade_id', tradeId)
    .eq('execution_type', 'fill');
  if (error) throw error;
  const sum = (data || []).reduce((acc, row) => acc + (toNum(row.amount) || 0), 0);
  return sum > 0 ? sum : 50;
}
async function getTradeQtyBase(tradeId, tradeRow) {
  const q = toNum(tradeRow?.qty_base);
  if (q && q > 0) return q;
  const { data, error } = await sb
    .from('trade_executions_prod')
    .select('qty_base')
    .eq('trade_id', tradeId)
    .eq('execution_type', 'fill');
  if (error) throw error;
  const sum = (data || []).reduce((acc, row) => acc + (toNum(row.qty_base) || 0), 0);
  return sum > 0 ? sum : null;
}
async function getPriceFromMarketMarks(pair) {
  const { data, error } = await sb
    .from('market_marks')
    .select('price,marked_at')
    .eq('symbol', pair)
    .order('marked_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? toNum(data[0].price) : null;
}
async function getLastFillPrice(tradeId) {
  const { data, error } = await sb
    .from('trade_executions_prod')
    .select('price,executed_at')
    .eq('trade_id', tradeId)
    .eq('execution_type', 'fill')
    .order('executed_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? toNum(data[0].price) : null;
}
async function writeCloseLedgerRow({ job, intentId, tradeId, pair, amount, qtyBase, price, priceSource, mode }) {
  const execId = randomUUID();
  const row = {
    id: execId,
    trade_id: tradeId,
    intent_id: intentId,
    execution_type: 'close',
    executed_at: nowIso(),
    price,
    amount,
    qty_base: qtyBase,
    fee: 0,
    fee_currency: 'USD',
    exchange: isLiveLikeMode(mode) ? 'coinbase' : 'paper',
    metadata: {
      source: 'worker_close_ledger',
      job_id: String(job.id),
      pair,
      price_source: priceSource,
      mode,
      worker_id: WORKER_ID,
    },
    created_at: nowIso(),
  };
  const { error } = await sb.from('trade_executions_prod').insert(row);
  if (error) throw error;
  return execId;
}
async function ensureCloseLedgerForJob({ job }) {
  try {
    if (!CLOSE_LEDGER_ENABLED) return { ok: true, did: false, code: 'disabled' };
    if (CLOSE_LEDGER_ASSUME_BOT_WRITES) return { ok: true, did: false, code: 'assume_bot_writes' };
    if (!job || job.type !== 'execute_intent') return { ok: true, did: false, code: 'not_execute_intent' };
    if (isLiveCloseJob(job)) return { ok: true, did: false, code: 'live_close_ledger_skipped' };

    const payload = job.payload || {};
    const action = safeTrim(payload.action);
    if (!isExitAction(action)) return { ok: true, did: false, code: 'not_close' };

    const intentId = safeTrim(job.intent_id || payload.intent_id || payload.intentId);
    if (!intentId) return { ok: false, did: false, code: 'close_ledger_missing_intent_id', detail: 'job.intent_id missing' };
    if (await closeAlreadyWrittenForIntent(intentId)) return { ok: true, did: false, code: 'close_already_written' };

    const intent = await fetchIntent(intentId).catch(() => null);
    const pair =
      safeTrim(payload.pair) ||
      safeTrim(intent?.raw_signal?.pair || intent?.raw_signal?.['pair']) ||
      normalizePairFromSymbol(payload.symbol || intent?.symbol);
    const mode =
      safeTrim(payload.execution_mode) ||
      safeTrim(intent?.execution_mode) ||
      'paper';

    if (isLiveLikeMode(mode)) return { ok: true, did: false, code: 'live_close_ledger_skipped' };

    let tradeId = safeTrim(payload.trade_id) || safeTrim(intent?.raw_signal?.trade_id || intent?.raw_signal?.['trade_id']);
    let tradeRow = null;
    if (!tradeId) {
      tradeRow = await findOpenPaperTradeByPair(pair);
      tradeId = tradeRow ? tradeRow.id : null;
    } else {
      tradeRow = await fetchOpenTradeById(tradeId);
    }
    if (!tradeId) return { ok: false, did: false, code: 'close_ledger_no_trade_found', detail: `pair=${pair || '(null)'}` };

    const tradeMode = tradeRow?.metadata?.mode ? String(tradeRow.metadata.mode) : mode;
    const hasFill = await hasAnyFill(tradeId);
    if (!hasFill && !isPaperLikeMode(tradeMode)) {
      return { ok: false, did: false, code: 'close_ledger_missing_fill', detail: `trade_id=${tradeId}` };
    }

    const amount = await getTradeAmount(tradeId, tradeRow);
    const qtyBase = await getTradeQtyBase(tradeId, tradeRow);
    const priceMarks = await getPriceFromMarketMarks(pair);
    const priceLastFill = await getLastFillPrice(tradeId);
    const price = priceMarks != null ? priceMarks : priceLastFill;
    const priceSource = priceMarks != null ? 'market_marks' : priceLastFill != null ? 'last_fill' : null;
    if (price == null) return { ok: false, did: false, code: 'close_ledger_missing_price', detail: `pair=${pair} trade_id=${tradeId}` };

    const execId = await writeCloseLedgerRow({
      job,
      intentId,
      tradeId,
      pair,
      amount,
      qtyBase,
      price,
      priceSource,
      mode: tradeMode,
    });
    log({
      tag: TAG,
      msg: 'CLOSE_LEDGER_WRITTEN',
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
    return { ok: true, did: true, code: 'close_ledger_written', exec_id: execId };
  } catch (err) {
    return { ok: false, did: false, code: 'close_ledger_exception', detail: String(err && err.message ? err.message : err) };
  }
}

// ---------- selfheal ----------
async function tradeIsOpen(tradeId) {
  if (!tradeId) return null;
  const row = await fetchOpenTradeById(tradeId);
  if (!row) return null;
  const mode = row?.metadata?.mode ? String(row.metadata.mode) : null;
  if (!isPaperLikeMode(mode)) return false;
  return String(row.status || '').toLowerCase() === 'open';
}
async function selfhealRequeueSameJob(oldJob, patchPayload) {
  const mergedPayload = {
    ...(oldJob.payload || {}),
    ...(patchPayload || {}),
    selfheal_prev_status: oldJob.status,
    selfheal_prev_last_error: oldJob.last_error,
    selfheal_prev_last_step: oldJob.last_step,
  };
  const { error } = await sb
    .from('execution_jobs')
    .update({
      status: 'queued',
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: nowIso(),
      last_step: 'selfheal_requeued',
      last_error: null,
      attempts: 0,
      run_at: nowIso(),
      payload: mergedPayload,
    })
    .eq('id', oldJob.id);
  if (error) throw error;
}
async function selfhealDeadletters(batch = SELFHEAL_BATCH) {
  if (!SELFHEAL_DEADLETTER) return 0;
  const { data, error } = await sb
    .from('execution_jobs')
    .select('id,type,status,payload,attempts,created_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id')
    .eq('status', 'failed')
    .eq('type', 'execute_intent')
    .order('created_at', { ascending: true })
    .limit(batch);
  if (error) throw error;

  let requeued = 0;
  for (const job of data || []) {
    const payload = job.payload || {};
    const action = safeTrim(payload.action).toLowerCase();
    if (!isExitAction(action)) continue;
    const intentId = safeTrim(job.intent_id || payload.intent_id || payload.intentId);
    const intent = await fetchIntent(intentId).catch(() => null);
    const tradeId = safeTrim(payload.trade_id || intent?.raw_signal?.trade_id);
    if (!tradeId) continue;
    const open = await tradeIsOpen(tradeId).catch(() => false);
    if (!open) continue;
    await selfhealRequeueSameJob(job, { selfheal_reason: 'trade_still_open' });
    requeued += 1;
  }
  return requeued;
}

// ---------- loop ----------
async function loop() {
  while (true) {
    try {
      log({ tag: TAG, msg: 'POLL', ts: nowIso(), types: TYPES });

      if (SELFHEAL_DEADLETTER) {
        log({ tag: TAG, msg: 'STEP_START', ts: nowIso(), step: 'selfhealDeadletters', batch: SELFHEAL_BATCH });
        const requeued = await selfhealDeadletters(SELFHEAL_BATCH);
        log({ tag: TAG, msg: 'STEP_OK', ts: nowIso(), step: 'selfhealDeadletters', requeued });
      }

      log({ tag: TAG, msg: 'STEP_START', ts: nowIso(), step: 'pickQueuedJob', types: TYPES });
      const candidate = await pickQueuedJob(TYPES);
      log({
        tag: TAG,
        msg: 'STEP_OK',
        ts: nowIso(),
        step: 'pickQueuedJob',
        found: Boolean(candidate),
        candidate_id: candidate ? candidate.id : null,
        candidate_type: candidate ? candidate.type : null,
        candidate_intent_id: candidate ? candidate.intent_id : null,
      });
      if (!candidate) {
        await sleep(POLL_MS);
        continue;
      }

      log({ tag: TAG, msg: 'STEP_START', ts: nowIso(), step: 'claimJob', candidate_id: candidate.id });
      const claimed = await claimJob(candidate.id);
      log({
        tag: TAG,
        msg: 'STEP_OK',
        ts: nowIso(),
        step: 'claimJob',
        claimed: Boolean(claimed),
        claimed_id: claimed ? claimed.id : null,
        claimed_type: claimed ? claimed.type : null,
        claimed_intent_id: claimed ? claimed.intent_id : null,
      });
      if (!claimed) {
        await sleep(250);
        continue;
      }

      log({
        tag: TAG,
        msg: 'JOB_CLAIMED',
        ts: nowIso(),
        id: claimed.id,
        type: claimed.type,
        intent_id: claimed.intent_id,
        attempts: claimed.attempts,
      });

      await touchHeartbeat(claimed.id, 'policy_preflight');
      const preflight = await policyPreflight(claimed);
      log({
        tag: TAG,
        msg: 'policy_preflight',
        ts: nowIso(),
        id: claimed.id,
        intent_id: claimed.intent_id,
        allow: preflight.allow,
        code: preflight.code,
        symbol: preflight.symbol || null,
      });
      if (!preflight.allow) {
        await cancelJobSkipped(claimed.id, `policy_cancelled_${preflight.code}`, preflight.code);
        log({
          tag: TAG,
          msg: 'JOB_POLICY_CANCELLED',
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

      await touchHeartbeat(claimed.id, 'direct_execution');
      log({ tag: TAG, msg: 'STEP: direct_execution', ts: nowIso(), id: claimed.id, intent_id: claimed.intent_id });
      const stopHeartbeat = startHeartbeat(claimed.id, JOB_HEARTBEAT_MS);
      let result;
      try {
        result = await executeDirect(claimed);
      } finally {
        stopHeartbeat();
      }

      if (result.ok) {
        const closeConfirm = getLiveCloseConfirmationState(result, claimed);
        log({
          tag: TAG,
          msg: 'DIRECT_EXECUTION_OK',
          ts: nowIso(),
          id: claimed.id,
          type: claimed.type,
          intent_id: claimed.intent_id,
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
          const errCode = closeConfirm.code || 'live_close_unconfirmed';
          if (attempts + 1 >= MAX_ATTEMPTS) {
            await markFailedDeadletter(claimed.id, errCode);
            log({
              tag: TAG,
              msg: 'JOB_DEADLETTERED',
              ts: nowIso(),
              id: claimed.id,
              type: claimed.type,
              last_error: errCode,
              detail: result.detail || null,
            });
          } else {
            await requeueWithBackoff(claimed, errCode);
            log({
              tag: TAG,
              msg: 'JOB_LIVE_CLOSE_PENDING_RETRYING',
              ts: nowIso(),
              id: claimed.id,
              type: claimed.type,
              last_error: errCode,
            });
          }
          await sleep(250);
          continue;
        }

        let ledger = { ok: true, did: false, code: 'not_needed' };
        if (isLiveCloseJob(claimed)) {
          await touchHeartbeat(claimed.id, 'live_close_skip_worker_ledger');
          ledger = { ok: true, did: false, code: 'live_close_journaled_by_bot' };
        } else {
          await touchHeartbeat(claimed.id, 'close_ledger');
          ledger = await ensureCloseLedgerForJob({ job: claimed });
          if (!ledger.ok) {
            const attempts = Number(claimed.attempts || 0);
            const errCode = ledger.code || 'close_ledger_failed';
            if (attempts + 1 >= MAX_ATTEMPTS) {
              await markFailedDeadletter(claimed.id, errCode);
              log({
                tag: TAG,
                msg: 'JOB_DEADLETTERED_CLOSE_LEDGER',
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
                msg: 'JOB_CLOSE_LEDGER_FAILED_RETRYING',
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
        }

        await touchHeartbeat(claimed.id, 'finalizing');
        await completeJob(claimed.id);
        log({
          tag: TAG,
          msg: 'JOB_COMPLETED',
          ts: nowIso(),
          id: claimed.id,
          type: claimed.type,
          close_ledger: ledger.code,
          live_close_confirmed: closeConfirm.liveClose ? closeConfirm.confirmed : null,
          live_close_code: closeConfirm.liveClose ? closeConfirm.code : null,
        });
      } else {
        const intentId = safeTrim(claimed.intent_id || claimed.payload?.intent_id || claimed.payload?.intentId);
        const dedupe = await detectAlreadyExecutedForIntent(intentId).catch(() => ({ alreadyExecuted: false, source: null }));
        if (dedupe.alreadyExecuted) {
          await touchHeartbeat(claimed.id, 'already_executed_conflict');
          await completeJob(claimed.id);
          log({
            tag: TAG,
            msg: 'JOB_COMPLETED_ALREADY_EXECUTED_CONFLICT',
            ts: nowIso(),
            id: claimed.id,
            type: claimed.type,
            intent_id: intentId || null,
            conflict_code: result.code,
            conflict_detail: result.detail || null,
            dedupe_source: dedupe.source || null,
            trade_id: dedupe.trade?.id || dedupe.execution?.trade_id || null,
            trade_status: dedupe.trade?.status || null,
            close_validation: dedupe.trade?.close_validation || null,
          });
          await sleep(250);
          continue;
        }

        const attempts = Number(claimed.attempts || 0);
        if (attempts + 1 >= MAX_ATTEMPTS) {
          await markFailedDeadletter(claimed.id, result.code);
          log({
            tag: TAG,
            msg: 'JOB_DEADLETTERED',
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
            msg: 'JOB_DIRECT_EXECUTION_FAILED_RETRYING',
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
      log({ tag: TAG, msg: 'LOOP_ERROR', ts: nowIso(), ...summarizeUnknownError(err) });
      await sleep(Math.max(1000, POLL_MS));
    }
  }
}

loop();
