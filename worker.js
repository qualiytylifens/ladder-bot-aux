/**
 * worker_live_cutover.js
 *
 * Purpose:
 * - Keep the legacy worker path available for NON-LIVE jobs only.
 * - NEVER claim or execute live jobs.
 * - Leave all LIVE execution_jobs for direct_executor.js.
 *
 * This is the runtime cutover guard that prevents old webhook worker
 * from interfering with sovereign live execution.
 */

'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const WORKER_ENABLED = !['0', 'false', 'FALSE', 'off', 'OFF'].includes(String(process.env.WORKER_ENABLED || '1'));
const WORKER_ID = process.env.WORKER_ID || 'legacy-worker-nonlive-1';
const POLL_MS = Number(process.env.POLL_MS || 2000);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 60000);
const JOB_HEARTBEAT_MS = Number(process.env.JOB_HEARTBEAT_MS || 15000);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 3);
const RETRY_BACKOFF_MS = Number(process.env.RETRY_BACKOFF_MS || 5000);
const WEBHOOK_URL = String(
  process.env.WORKER_WEBHOOK_URL ||
  process.env.BOT_WEBHOOK_URL ||
  process.env.WEBHOOK_URL ||
  ''
).trim();
const API_SECRET = String(process.env.API_SECRET || '').trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[WORKER_BOOT_ABORT] missing Supabase credentials');
  process.exit(1);
}

if (!WEBHOOK_URL) {
  console.error('[WORKER_BOOT_ABORT] missing webhook URL');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function isLivePayload(payload) {
  const execMode = String(
    payload?.execution_mode ||
    payload?.mode ||
    payload?.raw_signal?.execution_mode ||
    payload?.raw_signal?.mode ||
    ''
  ).trim().toLowerCase();

  return execMode === 'live';
}

async function fetchQueuedNonLiveJobs(limit = 10) {
  const { data, error } = await supabase
    .from('execution_jobs')
    .select('id,intent_id,status,attempts,run_at,claimed_by,heartbeat_at,payload')
    .eq('status', 'queued')
    .is('claimed_by', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return (data || []).filter((row) => !isLivePayload(row.payload));
}

async function claimJob(jobId) {
  const claimTs = nowIso();
  const { data, error } = await supabase
    .from('execution_jobs')
    .update({
      status: 'processing',
      claimed_by: WORKER_ID,
      heartbeat_at: claimTs,
      last_step: 'claimed',
      updated_at: claimTs,
    })
    .eq('id', jobId)
    .eq('status', 'queued')
    .is('claimed_by', null)
    .select('id,intent_id,status,attempts,payload')
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function heartbeatJob(jobId) {
  const beatTs = nowIso();
  const { error } = await supabase
    .from('execution_jobs')
    .update({
      heartbeat_at: beatTs,
      updated_at: beatTs,
      last_step: 'heartbeat',
    })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID);

  if (error) {
    console.error('[JOB_HEARTBEAT_FAILED]', { job_id: jobId, error: error.message });
  }
}

async function completeJob(jobId) {
  const doneTs = nowIso();
  const { error } = await supabase
    .from('execution_jobs')
    .update({
      status: 'completed',
      claimed_by: null,
      heartbeat_at: null,
      updated_at: doneTs,
      last_step: 'completed',
      last_error: null,
    })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID);

  if (error) throw error;
}

async function failOrRequeue(job) {
  const attempts = Number(job.attempts || 0) + 1;
  const isClose = String(job.payload?.action || '').trim().toLowerCase() === 'close';
  const shouldDeadletter = !isClose && attempts >= MAX_ATTEMPTS;
  const runAt = new Date(Date.now() + RETRY_BACKOFF_MS).toISOString();

  const patch = shouldDeadletter
    ? {
        status: 'failed',
        attempts,
        claimed_by: null,
        heartbeat_at: null,
        updated_at: nowIso(),
        last_step: 'failed_deadletter',
        last_error: job._runtime_error || 'worker_failed',
      }
    : {
        status: 'queued',
        attempts,
        claimed_by: null,
        heartbeat_at: null,
        updated_at: nowIso(),
        last_step: `retry_queued_${attempts}`,
        last_error: job._runtime_error || 'worker_failed',
        run_at: runAt,
      };

  const { error } = await supabase
    .from('execution_jobs')
    .update(patch)
    .eq('id', job.id)
    .eq('claimed_by', WORKER_ID);

  if (error) throw error;
}

async function postWebhook(job) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': API_SECRET,
    authorization: `Bearer ${API_SECRET}`,
    'x-worker-secret': API_SECRET,
  };

  const body = {
    job_id: job.id,
    intent_id: job.intent_id || null,
    payload: job.payload || {},
    worker_id: WORKER_ID,
    run_id: crypto.randomUUID(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text().catch(() => '');

    if (!res.ok) {
      const err = new Error(`webhook_failed_http_${res.status}`);
      err.status = res.status;
      err.responseText = text;
      throw err;
    }

    return { ok: true, status: res.status, body: text };
  } finally {
    clearTimeout(timer);
  }
}

async function processJob(job) {
  if (isLivePayload(job.payload)) {
    // Defensive guard. This worker should never touch live jobs.
    console.log('[WORKER_SKIP_LIVE_JOB]', {
      job_id: job.id,
      intent_id: job.intent_id || null,
      symbol: job.payload?.symbol || null,
      action: job.payload?.action || null,
    });
    return;
  }

  let heartbeatTimer = null;
  try {
    heartbeatTimer = setInterval(() => {
      heartbeatJob(job.id).catch(() => {});
    }, JOB_HEARTBEAT_MS);

    await postWebhook(job);
    await completeJob(job);
  } catch (err) {
    job._runtime_error = err?.message || String(err);
    await failOrRequeue(job);
    console.error('[WORKER_JOB_ERROR]', {
      job_id: job.id,
      intent_id: job.intent_id || null,
      error: job._runtime_error,
      status: err?.status || null,
    });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

async function mainLoop() {
  console.log('[WORKER_BOOT_OK]', {
    worker_id: WORKER_ID,
    mode: 'nonlive_only',
    webhook_url: WEBHOOK_URL,
    poll_ms: POLL_MS,
  });

  while (true) {
    try {
      if (!WORKER_ENABLED) {
        console.log('[WORKER_DISABLED_BY_ENV]', { worker_id: WORKER_ID });
        await sleep(POLL_MS);
        continue;
      }

      const candidates = await fetchQueuedNonLiveJobs(10);

      for (const row of candidates) {
        const claimed = await claimJob(row.id);
        if (!claimed) continue;
        await processJob(claimed);
      }
    } catch (err) {
      console.error('[WORKER_LOOP_ERROR]', {
        worker_id: WORKER_ID,
        message: err?.message || String(err),
        stack: err?.stack || null,
      });
    }

    await sleep(POLL_MS);
  }
}

mainLoop().catch((err) => {
  console.error('[WORKER_FATAL]', {
    worker_id: WORKER_ID,
    message: err?.message || String(err),
    stack: err?.stack || null,
  });
  process.exit(1);
});
