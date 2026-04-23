/**
 * direct_executor_settled_close.js
 *
 * Purpose:
 * - Schema-safe executor for execution_jobs without writing updated_at.
 * - Webhook-truth path:
 *   execution_jobs -> direct-executor -> ladder-bot /webhook/worker
 * - Hardened against stuck processing jobs and transient Supabase 502/503/504 errors.
 */

'use strict';

console.log('[WORKER_VERSION]', 'WORKER_CLOSE_FIX_2026_04_21_B');

const { createClient } = require('@supabase/supabase-js');

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
function normalizeWebhookUrl(u) {
  return safeTrim(u);
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
function summarizeUnknownError(err) {
  return {
    error_message: err && err.message ? err.message : String(err),
    error_name: err && err.name ? err.name : null,
    error_code: err && err.code ? err.code : null,
    error_details: err && err.details ? err.details : null,
    error_hint: err && err.hint ? err.hint : null,
    error_stack: err && err.stack ? err.stack : null,
    status: err && err.status ? err.status : null,
  };
}
function isHtmlBody(s) {
  const t = String(s || '').trim().toLowerCase();
  return t.startsWith('<!doctype html') || t.startsWith('<html') || t.includes('<body>') || t.includes('cloudflare');
}
function isTransientInfraError(err) {
  const msg = String(err?.message || '').toLowerCase();
  const details = String(err?.details || '').toLowerCase();
  const hint = String(err?.hint || '').toLowerCase();
  const stack = String(err?.stack || '').toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  const status = Number(err?.status || 0);

  if ([408, 429, 500, 502, 503, 504, 520, 522, 524].includes(status)) return true;
  if (['ecconnreset', 'etimedout', 'eai_again', 'enotfound', 'fetch_failed'].includes(code)) return true;

  const blob = [msg, details, hint, stack].join(' | ');
  return (
    /502 bad gateway/.test(blob) ||
    /503 service unavailable/.test(blob) ||
    /504 gateway timeout/.test(blob) ||
    /cloudflare/.test(blob) ||
    /host error/.test(blob) ||
    /bad gateway/.test(blob) ||
    /gateway timeout/.test(blob) ||
    /network error/.test(blob) ||
    /fetch failed/.test(blob) ||
    /socket hang up/.test(blob) ||
    /connection reset/.test(blob) ||
    /timed out/.test(blob) ||
    isHtmlBody(blob)
  );
}
function buildFetchWithSupabaseRetry(baseFetch, maxRetries, retryMs) {
  return async (url, options = {}) => {
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        const res = await baseFetch(url, options);
        const status = Number(res?.status || 0);
        if ([429, 500, 502, 503, 504, 520, 522, 524].includes(status)) {
          const clone = res.clone();
          const bodyText = await clone.text().catch(() => '');
          if (attempt <= maxRetries) {
            log({
              tag: 'AUX',
              msg: 'SUPABASE_HTTP_RETRY',
              ts: nowIso(),
              attempt,
              status,
              url: String(url).slice(0, 140),
              body_preview: String(bodyText).slice(0, 220),
            });
            await sleep(retryMs * attempt);
            continue;
          }
        }
        return res;
      } catch (err) {
        if (attempt <= maxRetries && isTransientInfraError(err)) {
          log({
            tag: 'AUX',
            msg: 'SUPABASE_FETCH_RETRY',
            ts: nowIso(),
            attempt,
            url: String(url).slice(0, 140),
            ...summarizeUnknownError(err),
          });
          await sleep(retryMs * attempt);
          continue;
        }
        throw err;
      }
    }
  };
}

const TAG = 'AUX';
const PROCESSING_STATUS = 'processing';
const WORKER_ENABLED = envBool('WORKER_ENABLED', true);
const WORKER_ID = process.env.WORKER_ID || 'ladder-worker-1';
const TYPES = parseTypes(process.env.TYPES || process.env.WORKER_TYPES || 'execute_intent');
const POLL_MS = envInt('POLL_MS', 3000);
const JOB_TIMEOUT_MS = envInt('JOB_TIMEOUT_MS', 60000);
const JOB_HEARTBEAT_MS = envInt('JOB_HEARTBEAT_MS', 15000);
const MAX_ATTEMPTS = envInt('MAX_ATTEMPTS', 3);
const RETRY_BACKOFF_MS = envInt('RETRY_BACKOFF_MS', 5000);
const STALE_PROCESSING_MS = envInt(
  'STALE_PROCESSING_MS',
  Math.max(JOB_TIMEOUT_MS + JOB_HEARTBEAT_MS + 5000, 90000)
);
const STALE_SCAN_EVERY_LOOPS = envInt('STALE_SCAN_EVERY_LOOPS', 15);
const SUPABASE_FETCH_RETRIES = envInt('SUPABASE_FETCH_RETRIES', 3);
const SUPABASE_FETCH_RETRY_MS = envInt('SUPABASE_FETCH_RETRY_MS', 1500);

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const WORKER_WEBHOOK_URL = normalizeWebhookUrl(
  process.env.WORKER_WEBHOOK_URL || process.env.WEBHOOK_URL || process.env.WORKER_WEBHOOK || ''
);
const API_SECRET = safeTrim(process.env.API_SECRET || '');

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[WORKER_BOOT_ABORT] missing Supabase credentials');
  process.exit(1);
}
if (!WORKER_WEBHOOK_URL) {
  console.error('[WORKER_BOOT_ABORT] missing webhook URL');
  process.exit(1);
}

const fetchWithSupabaseRetry = buildFetchWithSupabaseRetry(fetch, SUPABASE_FETCH_RETRIES, SUPABASE_FETCH_RETRY_MS);

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: fetchWithSupabaseRetry },
});

log({
  tag: TAG,
  msg: 'WORKER_STARTED',
  ts: nowIso(),
  WORKER_ENABLED,
  WORKER_ID,
  TYPES,
  POLL_MS,
  JOB_TIMEOUT_MS,
  JOB_HEARTBEAT_MS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  STALE_PROCESSING_MS,
  SUPABASE_FETCH_RETRIES,
  SUPABASE_FETCH_RETRY_MS,
  webhook_url_prefix: WORKER_WEBHOOK_URL.slice(0, 80),
  schema_safe_no_updated_at: true,
  processing_status: PROCESSING_STATUS,
});

if (!WORKER_ENABLED) {
  log({ tag: TAG, msg: 'WORKER_DISABLED_BY_ENV', ts: nowIso() });
  setTimeout(() => process.exit(0), 250);
  return;
}

async function touchHeartbeat(jobId, step = 'processing') {
  const { error } = await sb
    .from('execution_jobs')
    .update({
      heartbeat_at: nowIso(),
      last_step: step,
    })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID)
    .eq('status', PROCESSING_STATUS);

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
        ...summarizeUnknownError(err),
      });
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

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
      status: PROCESSING_STATUS,
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

async function completeJob(jobId) {
  const now = nowIso();
  const { error } = await sb
    .from('execution_jobs')
    .update({
      status: 'completed',
      heartbeat_at: now,
      last_step: 'completed',
    })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID);

  if (error) throw error;
}

async function markFailedDeadletter(jobId, lastErrorCode, detail = null) {
  const now = nowIso();
  const { error } = await sb
    .from('execution_jobs')
    .update({
      status: 'failed',
      heartbeat_at: now,
      last_step: 'failed_deadletter',
      last_error: detail ? JSON.stringify({ code: lastErrorCode || 'deadletter_max_attempts', detail }) : (lastErrorCode || 'deadletter_max_attempts'),
    })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID);

  if (error) throw error;
}

async function requeueWithBackoff(job, lastErrorCode, detail = null) {
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
      last_error: detail ? JSON.stringify({ code: lastErrorCode || 'retry', detail }) : (lastErrorCode || 'retry'),
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
    detail,
  });
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

async function executeViaWebhook(job) {
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

  const headers = { 'content-type': 'application/json' };
  if (API_SECRET) {
    headers['x-api-secret'] = API_SECRET;
    headers['x-api-key'] = API_SECRET;
    headers['authorization'] = `Bearer ${API_SECRET}`;
  }

  const res = await fetchWithTimeout(
    WORKER_WEBHOOK_URL,
    { method: 'POST', headers, body: JSON.stringify(body) },
    JOB_TIMEOUT_MS
  );

  const text = await res.text().catch(() => '');
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
      code: parsed.error || parsed.reason || 'webhook_returned_ok_false',
      detail: text.slice(0, 500),
      response: parsed,
      http_status: res.status,
    };
  }

  return {
    ok: true,
    code: 'ok',
    detail: text.slice(0, 500),
    response: parsed,
    http_status: res.status,
  };
}

async function reapStaleProcessingJobs() {
  try {
    const cutoffIso = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
    const { data, error } = await sb
      .from('execution_jobs')
      .select('id, attempts, claimed_by, heartbeat_at, claimed_at, type, intent_id')
      .eq('status', PROCESSING_STATUS)
      .not('claimed_by', 'is', null)
      .or(`heartbeat_at.lt.${cutoffIso},and(heartbeat_at.is.null,claimed_at.lt.${cutoffIso})`)
      .limit(25);

    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) return;

    for (const row of rows) {
      const attempts = Number(row.attempts || 0);
      if (attempts + 1 >= MAX_ATTEMPTS) {
        const { error: deadErr } = await sb
          .from('execution_jobs')
          .update({
            status: 'failed',
            heartbeat_at: nowIso(),
            last_step: 'failed_stale_processing_deadletter',
            last_error: 'stale_processing_deadletter',
          })
          .eq('id', row.id)
          .eq('status', PROCESSING_STATUS);
        if (deadErr) throw deadErr;

        log({
          tag: TAG,
          msg: 'STALE_JOB_DEADLETTERED',
          ts: nowIso(),
          id: row.id,
          intent_id: row.intent_id,
          claimed_by: row.claimed_by,
        });
      } else {
        const nextAttempts = attempts + 1;
        const nextRunAt = new Date(Date.now() + msBackoff(RETRY_BACKOFF_MS, attempts)).toISOString();
        const { error: rqErr } = await sb
          .from('execution_jobs')
          .update({
            status: 'queued',
            claimed_by: null,
            claimed_at: null,
            heartbeat_at: nowIso(),
            last_step: `stale_requeued_${nextAttempts}`,
            last_error: 'stale_processing_requeued',
            attempts: nextAttempts,
            run_at: nextRunAt,
          })
          .eq('id', row.id)
          .eq('status', PROCESSING_STATUS);
        if (rqErr) throw rqErr;

        log({
          tag: TAG,
          msg: 'STALE_JOB_REQUEUED',
          ts: nowIso(),
          id: row.id,
          intent_id: row.intent_id,
          claimed_by: row.claimed_by,
          attempt: nextAttempts,
          next_run_at: nextRunAt,
        });
      }
    }
  } catch (err) {
    log({
      tag: TAG,
      msg: 'STALE_SCAN_ERROR',
      ts: nowIso(),
      ...summarizeUnknownError(err),
    });
  }
}

async function processClaimedJob(claimed) {
  const stopHeartbeat = startHeartbeat(claimed.id);
  try {
    const result = await executeViaWebhook(claimed);

    if (result.ok) {
      await touchHeartbeat(claimed.id, 'finalizing');
      await completeJob(claimed.id);
      log({
        tag: TAG,
        msg: 'JOB_COMPLETED',
        ts: nowIso(),
        id: claimed.id,
        type: claimed.type,
        intent_id: claimed.intent_id,
        path: 'webhook_truth_schema_safe',
      });
      return;
    }

    const attempts = Number(claimed.attempts || 0);
    if (attempts + 1 >= MAX_ATTEMPTS) {
      await markFailedDeadletter(claimed.id, result.code, result.detail);
      log({
        tag: TAG,
        msg: 'JOB_DEADLETTERED',
        ts: nowIso(),
        id: claimed.id,
        intent_id: claimed.intent_id,
        last_error: result.code,
        detail: result.detail,
      });
      return;
    }

    await requeueWithBackoff(claimed, result.code, result.detail);
    log({
      tag: TAG,
      msg: 'JOB_WEBHOOK_FAILED_RETRYING',
      ts: nowIso(),
      id: claimed.id,
      intent_id: claimed.intent_id,
      last_error: result.code,
      detail: result.detail,
    });
  } catch (err) {
    const attempts = Number(claimed.attempts || 0);
    const summary = summarizeUnknownError(err);
    const timeoutLike =
      summary.error_name === 'AbortError' ||
      /aborted|timeout/i.test(summary.error_message || '');

    if (attempts + 1 >= MAX_ATTEMPTS) {
      await markFailedDeadletter(
        claimed.id,
        timeoutLike ? 'webhook_timeout' : 'webhook_exception',
        summary
      );
      log({
        tag: TAG,
        msg: 'JOB_EXCEPTION_DEADLETTERED',
        ts: nowIso(),
        id: claimed.id,
        intent_id: claimed.intent_id,
        timeout_like: timeoutLike,
        ...summary,
      });
      return;
    }

    await requeueWithBackoff(
      claimed,
      timeoutLike ? 'webhook_timeout' : 'webhook_exception',
      summary
    );
    log({
      tag: TAG,
      msg: 'JOB_EXCEPTION_REQUEUED',
      ts: nowIso(),
      id: claimed.id,
      intent_id: claimed.intent_id,
      timeout_like: timeoutLike,
      ...summary,
    });
  } finally {
    stopHeartbeat();
  }
}

async function loop() {
  let loopCount = 0;
  while (true) {
    try {
      loopCount += 1;
      if (loopCount % Math.max(1, STALE_SCAN_EVERY_LOOPS) === 0) {
        await reapStaleProcessingJobs();
      }

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
        msg: 'JOB_CLAIMED',
        ts: nowIso(),
        id: claimed.id,
        type: claimed.type,
        intent_id: claimed.intent_id,
        attempts: claimed.attempts,
      });

      await processClaimedJob(claimed);
      await sleep(250);
    } catch (err) {
      log({
        tag: TAG,
        msg: 'LOOP_ERROR',
        ts: nowIso(),
        ...summarizeUnknownError(err),
      });
      await sleep(Math.max(1000, POLL_MS));
    }
  }
}

loop();
