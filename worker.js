/**
 * worker.js (CommonJS)
 * ROLLBACK: restore proven webhook truth path.
 *
 * Flow:
 *   Supabase execution_jobs -> worker -> ladder-bot /webhook/worker -> Coinbase + DB truth
 *
 * Version:
 *   ROLLBACK_V1_WEBHOOK_TRUTH
 */

const { createClient } = require('@supabase/supabase-js');

function nowIso() { return new Date().toISOString(); }
function log(obj) { console.log(JSON.stringify(obj)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
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
function safeTrim(v) { return String(v || '').trim(); }
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
function normalizeWebhookUrl(u) { return safeTrim(u); }
function normalizePolicySymbol(payload, intent) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const i = intent && typeof intent === 'object' ? intent : {};
  const raw = i.raw_signal && typeof i.raw_signal === 'object' ? i.raw_signal : {};
  const symbol = safeTrim(p.symbol) || safeTrim(p.pair) || safeTrim(raw.symbol) || safeTrim(raw.pair) || safeTrim(i.symbol);
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
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
function getLiveCloseConfirmationState(result, claimed) {
  const payload = claimed && claimed.payload ? claimed.payload : {};
  const action = safeTrim(payload.action);
  const execMode = safeTrim(payload.execution_mode || payload.mode);
  const response = result && result.response ? result.response : {};
  const liveClose = isExitAction(action) && isLiveLikeMode(execMode);
  if (!liveClose) return { liveClose: false, confirmed: true, code: 'not_live_close' };

  const closeValidation = safeTrim(
    response.close_validation || response.closeValidation || response.validation ||
    response.data?.close_validation || response.data?.closeValidation
  ).toLowerCase();

  const confirmedOrderId = safeTrim(
    response.confirmed_order_id || response.confirmedOrderId || response.order_id || response.orderId ||
    response.data?.confirmed_order_id || response.data?.confirmedOrderId || response.data?.order_id || response.data?.orderId
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
  const confirmed = brokerConfirmed || coinbaseFlatConfirmed || (confirmedOrderId && !/^CST_/i.test(confirmedOrderId));

  if (confirmed) return { liveClose: true, confirmed: true, code: brokerConfirmed ? 'broker_order_confirmed' : 'coinbase_flat_confirmed' };
  if (pendingConfirmation) return { liveClose: true, confirmed: false, code: 'live_close_pending_confirmation' };
  return { liveClose: true, confirmed: false, code: 'live_close_unconfirmed' };
}

const TAG = 'AUX';
const WORKER_ENABLED = envBool('WORKER_ENABLED', true);
const WORKER_ID = process.env.WORKER_ID || 'ladder-worker-1';
const TYPES = parseTypes(process.env.TYPES || process.env.WORKER_TYPES || 'execute_intent');
const POLL_MS = envInt('POLL_MS', 2000);
const JOB_TIMEOUT_MS = envInt('JOB_TIMEOUT_MS', 60000);
const JOB_HEARTBEAT_MS = envInt('JOB_HEARTBEAT_MS', 15000);
const MAX_ATTEMPTS = envInt('MAX_ATTEMPTS', 3);
const RETRY_BACKOFF_MS = envInt('RETRY_BACKOFF_MS', 5000);
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const WORKER_WEBHOOK_URL = normalizeWebhookUrl(
  process.env.WORKER_WEBHOOK_URL || process.env.WEBHOOK_URL || process.env.WORKER_WEBHOOK || ''
);
const API_SECRET = safeTrim(process.env.API_SECRET || '');

const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const hasWebhook = Boolean(WORKER_WEBHOOK_URL);
const hasApiSecret = Boolean(API_SECRET);

log({ tag: TAG, msg: 'WORKER_VERSION_CHECK', ts: nowIso(), version: 'ROLLBACK_V1_WEBHOOK_TRUTH' });
log({ tag: TAG, msg: 'WORKER_STARTED', ts: nowIso(), WORKER_ENABLED, WORKER_ID, TYPES, POLL_MS, JOB_TIMEOUT_MS, JOB_HEARTBEAT_MS, MAX_ATTEMPTS, RETRY_BACKOFF_MS, hasSupabase, hasWebhook, hasApiSecret, webhook_url: WORKER_WEBHOOK_URL || null });

if (!WORKER_ENABLED) { log({ tag: TAG, msg: 'WORKER_DISABLED_BY_ENV', ts: nowIso() }); setTimeout(() => process.exit(0), 250); return; }
if (!hasSupabase) { log({ tag: TAG, msg: 'FATAL_MISSING_SUPABASE_ENV', ts: nowIso() }); process.exit(1); }
if (!hasWebhook) { log({ tag: TAG, msg: 'FATAL_MISSING_WEBHOOK_URL', ts: nowIso() }); process.exit(1); }

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

async function touchHeartbeat(jobId, step = 'processing') {
  const { error } = await sb.from('execution_jobs').update({ heartbeat_at: nowIso(), last_step: step }).eq('id', jobId).eq('claimed_by', WORKER_ID).eq('status', 'running');
  if (error) throw error;
}
function startHeartbeat(jobId, intervalMs = JOB_HEARTBEAT_MS) {
  const timer = setInterval(() => {
    touchHeartbeat(jobId, 'processing').catch((err) => {
      log({ tag: TAG, msg: 'HEARTBEAT_ERROR', ts: nowIso(), job_id: jobId, error: String(err && err.message ? err.message : err) });
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
async function completeJob(jobId) {
  const now = nowIso();
  const { error } = await sb.from('execution_jobs').update({ status: 'completed', heartbeat_at: now, last_step: 'completed' }).eq('id', jobId).eq('claimed_by', WORKER_ID);
  if (error) throw error;
}
async function cancelJobSkipped(jobId, step, note) {
  const now = nowIso();
  const { error } = await sb.from('execution_jobs').update({ status: 'cancelled', heartbeat_at: now, last_step: step || 'policy_cancelled', last_error: note || null }).eq('id', jobId).eq('claimed_by', WORKER_ID);
  if (error) throw error;
}
async function markFailedDeadletter(jobId, lastErrorCode) {
  const now = nowIso();
  const { error } = await sb.from('execution_jobs').update({ status: 'failed', heartbeat_at: now, last_step: 'failed_deadletter', last_error: lastErrorCode || 'deadletter_max_attempts' }).eq('id', jobId).eq('claimed_by', WORKER_ID);
  if (error) throw error;
}
async function requeueWithBackoff(job, lastErrorCode) {
  const now = new Date();
  const backoffMs = msBackoff(RETRY_BACKOFF_MS, job.attempts);
  const nextRunAt = new Date(now.getTime() + backoffMs).toISOString();
  const nextAttempts = Number(job.attempts || 0) + 1;
  const { error } = await sb.from('execution_jobs').update({
    status: 'queued', claimed_by: null, claimed_at: null, heartbeat_at: now.toISOString(),
    last_step: `retry_queued_${nextAttempts}`, last_error: lastErrorCode || 'retry', attempts: nextAttempts, run_at: nextRunAt,
  }).eq('id', job.id).eq('claimed_by', WORKER_ID);
  if (error) throw error;
  log({ tag: TAG, msg: 'JOB_REQUEUED', ts: nowIso(), id: job.id, attempt: nextAttempts, next_run_at: nextRunAt, last_error: lastErrorCode });
}
async function pickQueuedJob(types) {
  const now = nowIso();
  const { data, error } = await sb.from('execution_jobs')
    .select('id,type,status,payload,attempts,created_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id')
    .in('type', types).eq('status', 'queued').is('claimed_by', null).or(`run_at.is.null,run_at.lte.${now}`)
    .order('run_at', { ascending: true }).order('created_at', { ascending: true }).limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function claimJob(jobId) {
  const now = nowIso();
  const { data, error } = await sb.from('execution_jobs').update({
    status: 'running', claimed_by: WORKER_ID, claimed_at: now, heartbeat_at: now, last_step: 'claimed', last_error: null,
  }).eq('id', jobId).eq('status', 'queued').is('claimed_by', null).or(`run_at.is.null,run_at.lte.${now}`)
    .select('id,type,status,payload,attempts,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id').limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function executeViaWebhook(job) {
  const payload = { ...(job.payload || {}), intent_id: safeTrim(job.intent_id || job.payload?.intent_id || job.payload?.intentId) };
  const body = { job_id: job.id, type: job.type, payload, intent_id: payload.intent_id || null, worker_id: WORKER_ID, ts: nowIso() };
  const headers = { 'content-type': 'application/json' };
  if (hasApiSecret) {
    headers['x-api-secret'] = API_SECRET;
    headers['x-api-key'] = API_SECRET;
    headers.authorization = `Bearer ${API_SECRET}`;
  }
  const res = await fetchWithTimeout(WORKER_WEBHOOK_URL, { method: 'POST', headers, body: JSON.stringify(body) }, JOB_TIMEOUT_MS);
  const text = await res.text().catch(() => '');
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) return { ok: false, code: `webhook_failed_http_${res.status}`, detail: text.slice(0, 500), response: parsed, http_status: res.status };
  if (parsed && parsed.ok === false) return { ok: false, code: parsed.error || parsed.reason || 'webhook_returned_ok_false', detail: text.slice(0, 500), response: parsed, http_status: res.status };
  return { ok: true, code: 'ok', detail: text.slice(0, 500), response: parsed, http_status: res.status };
}
async function fetchIntent(intentId) {
  if (!intentId) return null;
  const { data, error } = await sb.from('execution_intents').select('id,raw_signal,action,symbol,execution_mode').eq('id', intentId).limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function fetchAlphaDecisionPolicy(symbol) {
  const { data, error } = await sb.from('alpha_decision_policy_v2').select('*').eq('symbol', symbol).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}
async function policyPreflight(job) {
  const payload = job && job.payload ? job.payload : {};
  const intent = await fetchIntent(job.intent_id).catch(() => null);
  const action = safeTrim(payload.action || intent?.action).toLowerCase();
  const mode = safeTrim(payload.execution_mode || intent?.execution_mode || payload.mode || 'paper').toLowerCase();
  if (!action) return { allow: false, code: 'missing_action', symbol: null, policy: null };
  if (isExitAction(action)) return { allow: true, code: 'exit_bypass', symbol: normalizePolicySymbol(payload, intent), policy: null };
  if (mode !== 'live') return { allow: true, code: 'paper_bypass', symbol: normalizePolicySymbol(payload, intent), policy: null };
  const symbol = normalizePolicySymbol(payload, intent);
  if (!symbol) return { allow: false, code: 'missing_symbol', symbol: null, policy: null };
  try {
    const policy = await fetchAlphaDecisionPolicy(symbol);
    if (!policy) return { allow: true, code: 'no_policy_row', symbol, policy: null };
    const side = normalizeIntentSide(action);
    const sizeTier = safeTrim(policy.size_tier || '').toUpperCase();
    const sidePermission = safeTrim(policy.side_permission || '').toUpperCase();
    if (sizeTier === 'TIER_0' || sidePermission === 'FLAT_ONLY') return { allow: false, code: 'flat_only', symbol, policy };
    if (side === 'LONG' && sidePermission.includes('SHORT')) return { allow: false, code: 'wrong_side', symbol, policy };
    if (side === 'SHORT' && sidePermission.includes('LONG')) return { allow: false, code: 'wrong_side', symbol, policy };
    return { allow: true, code: 'policy_allow', symbol, policy };
  } catch (err) {
    log({ tag: TAG, msg: 'POLICY_PREFLIGHT_ERROR', ts: nowIso(), symbol, ...summarizeUnknownError(err) });
    return { allow: true, code: 'policy_lookup_failed_allow', symbol, policy: null };
  }
}
async function findTradeForIntent(intentId) {
  if (!intentId) return null;
  const { data, error } = await sb.from('trades_prod').select('id,status,signal_id,symbol,created_at,closed_at,metadata,close_validation,close_order_id').eq('signal_id', intentId).order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function findExecutionForIntent(intentId) {
  if (!intentId) return null;
  const { data, error } = await sb.from('trade_executions_prod').select('id,trade_id,intent_id,execution_type,executed_at,created_at').eq('intent_id', intentId).order('created_at', { ascending: false }).limit(1);
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

async function loop() {
  while (true) {
    try {
      log({ tag: TAG, msg: 'POLL', ts: nowIso(), types: TYPES });
      const candidate = await pickQueuedJob(TYPES);
      if (!candidate) { await sleep(POLL_MS); continue; }
      const claimed = await claimJob(candidate.id);
      if (!claimed) { await sleep(250); continue; }

      log({ tag: TAG, msg: 'JOB_CLAIMED', ts: nowIso(), id: claimed.id, type: claimed.type, intent_id: claimed.intent_id, attempts: claimed.attempts });

      await touchHeartbeat(claimed.id, 'policy_preflight');
      const preflight = await policyPreflight(claimed);
      log({ tag: TAG, msg: 'POLICY_PREFLIGHT', ts: nowIso(), id: claimed.id, intent_id: claimed.intent_id, allow: preflight.allow, code: preflight.code, symbol: preflight.symbol || null });
      if (!preflight.allow) {
        await cancelJobSkipped(claimed.id, `policy_cancelled_${preflight.code}`, preflight.code);
        await sleep(250);
        continue;
      }

      await touchHeartbeat(claimed.id, 'webhook_dispatch');
      log({ tag: TAG, msg: 'WEBHOOK_TRUTH_PATH_START', ts: nowIso(), id: claimed.id, intent_id: claimed.intent_id, webhook_url: WORKER_WEBHOOK_URL });
      const stopHeartbeat = startHeartbeat(claimed.id, JOB_HEARTBEAT_MS);
      let result;
      try {
        result = await executeViaWebhook(claimed);
      } finally {
        stopHeartbeat();
      }

      if (result.ok) {
        const closeConfirm = getLiveCloseConfirmationState(result, claimed);
        log({ tag: TAG, msg: 'WEBHOOK_OK', ts: nowIso(), id: claimed.id, intent_id: claimed.intent_id, http_status: result.http_status || null, order_id: result.response?.order_id || null, live_close_confirmed: closeConfirm.liveClose ? closeConfirm.confirmed : null, live_close_code: closeConfirm.liveClose ? closeConfirm.code : null });
        if (closeConfirm.liveClose && !closeConfirm.confirmed) {
          const attempts = Number(claimed.attempts || 0);
          const errCode = closeConfirm.code || 'live_close_unconfirmed';
          if (attempts + 1 >= MAX_ATTEMPTS) await markFailedDeadletter(claimed.id, errCode);
          else await requeueWithBackoff(claimed, errCode);
          await sleep(250);
          continue;
        }
        await touchHeartbeat(claimed.id, 'finalizing');
        await completeJob(claimed.id);
        log({ tag: TAG, msg: 'JOB_COMPLETED', ts: nowIso(), id: claimed.id, intent_id: claimed.intent_id, path: 'webhook_truth' });
      } else {
        if (result.http_status === 409) {
          const intentId = safeTrim(claimed.intent_id || claimed.payload?.intent_id || claimed.payload?.intentId);
          const dedupe = await detectAlreadyExecutedForIntent(intentId).catch(() => ({ alreadyExecuted: false, source: null }));
          if (dedupe.alreadyExecuted) {
            await touchHeartbeat(claimed.id, 'already_executed_conflict');
            await completeJob(claimed.id);
            log({ tag: TAG, msg: 'JOB_COMPLETED_ALREADY_EXECUTED_CONFLICT', ts: nowIso(), id: claimed.id, intent_id: intentId || null, dedupe_source: dedupe.source || null, trade_id: dedupe.trade?.id || dedupe.execution?.trade_id || null });
            await sleep(250);
            continue;
          }
        }
        const attempts = Number(claimed.attempts || 0);
        if (attempts + 1 >= MAX_ATTEMPTS) {
          await markFailedDeadletter(claimed.id, result.code);
          log({ tag: TAG, msg: 'JOB_DEADLETTERED', ts: nowIso(), id: claimed.id, intent_id: claimed.intent_id, last_error: result.code, detail: result.detail });
        } else {
          await requeueWithBackoff(claimed, result.code);
          log({ tag: TAG, msg: 'JOB_WEBHOOK_FAILED_RETRYING', ts: nowIso(), id: claimed.id, intent_id: claimed.intent_id, last_error: result.code, detail: result.detail });
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
