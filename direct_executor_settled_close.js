/**
 * ============================================
 * DIRECT EXECUTOR SETTLED CLOSE - RECOVERY V1
 * Supabase = brain
 * This service = dumb executor (muscle)
 *
 * Purpose:
 * - Dedicated recovery executor for CLOSE / EXIT jobs only
 * - Strong runtime identity marker
 * - Safe claim verification before webhook POST
 * - Retry/backoff for transient transport failures
 * - Clear per-job logging trail
 *
 * Assumptions:
 * - execution_jobs has at least:
 *     id, intent_id, type, status, payload, created_at
 * - It likely also has:
 *     attempts, run_at, claimed_by, claimed_at, heartbeat_at, last_step, last_error
 * - ladder-bot /webhook/worker processes the payload synchronously enough that
 *   200/202 can be treated as successful completion for this recovery pass
 *
 * Notes:
 * - This executor intentionally ignores non-close jobs.
 * - This executor does NOT try to be a generic worker.
 * ============================================
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

if (typeof fetch !== 'function') {
  throw new Error('Global fetch is not available in this Node runtime');
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_SECRET = process.env.API_SECRET;
const WEBHOOK_URL =
  process.env.WEBHOOK_URL ||
  process.env.BOT_WEBHOOK_URL ||
  process.env.WORKER_WEBHOOK_URL;

const POLL_MS = parseInt(process.env.EXECUTOR_POLL_MS || process.env.POLL_MS || '3000', 10);
const FETCH_LIMIT = parseInt(process.env.EXECUTOR_FETCH_LIMIT || '10', 10);
const MAX_ATTEMPTS = parseInt(process.env.EXECUTOR_MAX_ATTEMPTS || '5', 10);
const CLAIMED_BY = process.env.EXECUTOR_NAME || 'direct-executor-settled-close-recovery-v1';
const HEARTBEAT_EVERY_MS = parseInt(process.env.EXECUTOR_HEARTBEAT_MS || '15000', 10);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}
if (!API_SECRET) {
  throw new Error('Missing API_SECRET');
}
if (!WEBHOOK_URL) {
  throw new Error('Missing WEBHOOK_URL / BOT_WEBHOOK_URL / WORKER_WEBHOOK_URL');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

console.log('[DIRECT_EXECUTOR_CLOSE_RECOVERY_V1]', {
  file: 'direct_executor_settled_close.js',
  claimed_by: CLAIMED_BY,
  poll_ms: POLL_MS,
  fetch_limit: FETCH_LIMIT,
  max_attempts: MAX_ATTEMPTS,
  webhook_url: WEBHOOK_URL,
  node_env: process.env.NODE_ENV || null
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return JSON.stringify({
      stringify_error: err?.message || String(err)
    });
  }
}

function truncate(value, max = 2000) {
  if (value == null) return value;
  const s = typeof value === 'string' ? value : safeJson(value);
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

function lower(value) {
  return String(value || '').trim().toLowerCase();
}

function isRetryableHttpStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504, 522, 523, 524].includes(Number(status));
}

function isRetryableError(err) {
  const msg = lower(err?.message || err);
  return (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('cloudflare') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('522') ||
    msg.includes('523') ||
    msg.includes('524')
  );
}

function nextBackoffMs(attempts) {
  const base = 5000;
  const cap = 120000;
  const ms = base * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(ms, cap);
}

function plusMsIso(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function deriveCloseIntent(job) {
  const payload = job?.payload || {};
  const raw = payload?.raw || {};
  const meta = payload?.metadata || {};

  const values = [
    payload?.action,
    payload?.intent_kind,
    payload?.reason,
    payload?.side,
    raw?._is_close_intent,
    raw?.is_close_intent,
    raw?.intent_kind,
    raw?.action,
    raw?.reason,
    meta?._is_close_intent,
    meta?.is_close_intent,
    meta?.intent_kind,
    meta?.action,
    meta?.reason
  ];

  const textBlob = lower(values.filter(v => v != null).map(v => String(v)).join(' | '));

  const boolSignals = [
    payload?._is_close_intent === true,
    payload?.is_close_intent === true,
    raw?._is_close_intent === true,
    raw?.is_close_intent === true,
    meta?._is_close_intent === true,
    meta?.is_close_intent === true
  ];

  const textSignals = [
    textBlob.includes('close_trade'),
    textBlob.includes('close pending'),
    textBlob.includes('close_pending'),
    textBlob.includes('close'),
    textBlob.includes('exit'),
    textBlob.includes('approved_paper_close'),
    textBlob.includes('approved_live_close'),
    textBlob.includes('tier_exit')
  ];

  return boolSignals.some(Boolean) || textSignals.some(Boolean);
}

function summarizeJob(job) {
  const payload = job?.payload || {};
  return {
    jobId: job?.id || null,
    intentId: job?.intent_id || null,
    type: job?.type || null,
    status: job?.status || null,
    created_at: job?.created_at || null,
    attempts: Number(job?.attempts || 0),
    symbol: payload?.symbol || payload?.pair || payload?.product_id || payload?.canonical_symbol || null,
    action: payload?.action || null,
    intent_kind: payload?.intent_kind || payload?.raw?.intent_kind || null,
    reason: payload?.reason || payload?.raw?.reason || null,
    is_close_candidate: deriveCloseIntent(job)
  };
}

async function updateJob(jobId, patch) {
  const { error } = await supabase
    .from('execution_jobs')
    .update({
      heartbeat_at: nowIso(),
      ...patch
    })
    .eq('id', jobId);

  if (error) {
    console.error('[JOB_UPDATE_ERROR]', {
      jobId,
      patch_keys: Object.keys(patch || {}),
      message: error.message
    });
  }
}

async function markCompleted(jobId, lastStep, extra = {}) {
  await updateJob(jobId, {
    status: 'completed',
    last_step: lastStep,
    last_error: Object.keys(extra).length ? safeJson(extra) : null
  });
}

async function markRetryable(job, reason) {
  const currentAttempts = Number(job?.attempts || 0);
  const attempts = currentAttempts + 1;
  const backoffMs = nextBackoffMs(attempts);

  if (attempts >= MAX_ATTEMPTS) {
    await updateJob(job.id, {
      status: 'failed',
      attempts,
      last_step: reason.last_step || 'failed_retry_exhausted',
      last_error: safeJson({
        retry_exhausted: true,
        attempts,
        ...reason
      })
    });

    console.error('[JOB_FAILED_RETRY_EXHAUSTED]', {
      jobId: job.id,
      attempts,
      reason: truncate(reason)
    });
    return;
  }

  await updateJob(job.id, {
    status: 'queued',
    attempts,
    claimed_by: null,
    claimed_at: null,
    run_at: plusMsIso(backoffMs),
    last_step: reason.last_step || 'requeued_retryable',
    last_error: safeJson({
      retryable: true,
      attempts,
      backoff_ms: backoffMs,
      ...reason
    })
  });

  console.warn('[JOB_REQUEUED_RETRYABLE]', {
    jobId: job.id,
    attempts,
    backoff_ms: backoffMs,
    reason: truncate(reason)
  });
}

async function markFailed(job, reason) {
  const attempts = Number(job?.attempts || 0) + 1;

  await updateJob(job.id, {
    status: 'failed',
    attempts,
    last_step: reason.last_step || 'failed_terminal',
    last_error: safeJson({
      terminal: true,
      attempts,
      ...reason
    })
  });

  console.error('[JOB_FAILED_TERMINAL]', {
    jobId: job.id,
    attempts,
    reason: truncate(reason)
  });
}

async function claimJob(job) {
  const claimTs = nowIso();

  const { data, error } = await supabase
    .from('execution_jobs')
    .update({
      status: 'processing',
      claimed_by: CLAIMED_BY,
      claimed_at: claimTs,
      heartbeat_at: claimTs,
      last_step: 'claimed_for_close_recovery'
    })
    .eq('id', job.id)
    .eq('status', 'queued')
    .select('id, status, claimed_by, claimed_at');

  if (error) {
    return { ok: false, kind: 'claim_error', error };
  }

  if (!data || data.length !== 1) {
    return { ok: false, kind: 'claim_not_acquired' };
  }

  const row = data[0];
  if (row.claimed_by !== CLAIMED_BY || row.status !== 'processing') {
    return { ok: false, kind: 'claim_mismatch', row };
  }

  return { ok: true, row };
}

async function heartbeatProcessingJob(jobId) {
  await updateJob(jobId, {
    heartbeat_at: nowIso(),
    last_step: 'processing_webhook_post'
  });
}

async function fetchQueuedCandidates() {
  const { data, error } = await supabase
    .from('execution_jobs')
    .select('*')
    .eq('status', 'queued')
    .eq('type', 'execute_intent')
    .or(`run_at.is.null,run_at.lte.${nowIso()}`)
    .order('created_at', { ascending: true })
    .limit(FETCH_LIMIT);

  if (error) {
    console.error('[FETCH_ERROR]', { message: error.message });
    return [];
  }

  const jobs = Array.isArray(data) ? data : [];
  const closeJobs = jobs.filter(deriveCloseIntent);

  if (jobs.length > 0) {
    console.log('[FETCH_BATCH]', {
      fetched: jobs.length,
      close_candidates: closeJobs.length,
      skipped_non_close: jobs.length - closeJobs.length
    });
  }

  return closeJobs;
}

async function postWebhook(job) {
  const controller = new AbortController();
  const timeoutMs = parseInt(process.env.EXECUTOR_FETCH_TIMEOUT_MS || '20000', 10);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-secret': API_SECRET
      },
      body: JSON.stringify(job.payload || {}),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function handleJob(job) {
  const summary = summarizeJob(job);

  console.log('[JOB_SEEN]', summary);

  if (!summary.is_close_candidate) {
    console.log('[JOB_SKIPPED_NOT_CLOSE]', summary);
    return;
  }

  const claim = await claimJob(job);

  if (!claim.ok) {
    console.warn('[JOB_CLAIM_SKIPPED]', {
      jobId: job.id,
      kind: claim.kind,
      message: claim.error?.message || null
    });
    return;
  }

  console.log('[JOB_CLAIMED]', {
    jobId: job.id,
    intentId: job.intent_id || null,
    claimed_by: CLAIMED_BY
  });

  let lastHeartbeatAt = Date.now();

  try {
    if (Date.now() - lastHeartbeatAt >= HEARTBEAT_EVERY_MS) {
      await heartbeatProcessingJob(job.id);
      lastHeartbeatAt = Date.now();
    }

    console.log('[JOB_POSTING_WEBHOOK]', {
      jobId: job.id,
      intentId: job.intent_id || null,
      webhook_url: WEBHOOK_URL,
      payload_preview: truncate(job.payload, 1200)
    });

    const res = await postWebhook(job);
    const text = await res.text();

    console.log('[JOB_WEBHOOK_RESPONSE]', {
      jobId: job.id,
      status: res.status,
      body: truncate(text, 2000)
    });

    if (res.status === 200 || res.status === 202) {
      await markCompleted(job.id, 'completed_close_recovery', {
        http_status: res.status,
        body: truncate(text, 1500)
      });

      console.log('[JOB_COMPLETED]', {
        jobId: job.id,
        status: res.status
      });
      return;
    }

    if (res.status === 409) {
      await markCompleted(job.id, 'completed_idempotent_close_recovery', {
        http_status: res.status,
        body: truncate(text, 1500),
        idempotent: true
      });

      console.log('[JOB_COMPLETED_IDEMPOTENT]', {
        jobId: job.id,
        status: res.status
      });
      return;
    }

    if (isRetryableHttpStatus(res.status)) {
      await markRetryable(job, {
        last_step: 'retryable_webhook_http',
        http_status: res.status,
        body: truncate(text, 2000),
        payload: job.payload || null
      });
      return;
    }

    await markFailed(job, {
      last_step: 'terminal_webhook_http',
      http_status: res.status,
      body: truncate(text, 2000),
      payload: job.payload || null
    });
  } catch (err) {
    const details = {
      last_step: isRetryableError(err) ? 'retryable_exception' : 'terminal_exception',
      message: err?.message || String(err),
      stack: truncate(err?.stack || null, 4000),
      payload: job.payload || null
    };

    console.error('[JOB_EXCEPTION]', {
      jobId: job.id,
      retryable: isRetryableError(err),
      message: err?.message || String(err)
    });

    if (isRetryableError(err)) {
      await markRetryable(job, details);
      return;
    }

    await markFailed(job, details);
  }
}

async function loop() {
  while (true) {
    try {
      const jobs = await fetchQueuedCandidates();

      for (const job of jobs) {
        await handleJob(job);
      }
    } catch (err) {
      console.error('[LOOP_ERROR]', {
        message: err?.message || String(err),
        stack: truncate(err?.stack || null, 4000)
      });
    }

    await sleep(POLL_MS);
  }
}

loop().catch(err => {
  console.error('[DIRECT_EXECUTOR_FATAL]', {
    message: err?.message || String(err),
    stack: truncate(err?.stack || null, 4000)
  });
  process.exit(1);
});
