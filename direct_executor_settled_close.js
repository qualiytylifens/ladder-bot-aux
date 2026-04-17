/**
 * ============================================
 * DIRECT EXECUTOR (V4 LIVE) - DEBUG BUILD
 * Supabase = brain
 * This service = dumb executor (muscle)
 * Adds detailed logging and DB failure persistence
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
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const POLL_MS = parseInt(process.env.EXECUTOR_POLL_MS || '3000', 10);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}
if (!API_SECRET) {
  throw new Error('Missing API_SECRET');
}
if (!WEBHOOK_URL) {
  throw new Error('Missing WEBHOOK_URL');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

console.log('[DIRECT_EXECUTOR_BOOT] starting...', {
  poll_ms: POLL_MS,
  webhook_url_prefix: WEBHOOK_URL.slice(0, 80)
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function markFailed(jobId, details) {
  const payload = {
    failed_at: new Date().toISOString(),
    ...details
  };

  const { error } = await supabase
    .from('execution_jobs')
    .update({
      status: 'failed',
      last_step: details.last_step || 'failed_debug',
      last_error: safeJson(payload),
      heartbeat_at: new Date().toISOString()
    })
    .eq('id', jobId);

  if (error) {
    console.error('[MARK_FAILED_ERROR]', {
      jobId,
      message: error.message
    });
  }
}

async function processJobs() {
  const { data: jobs, error } = await supabase
    .from('execution_jobs')
    .select('*')
    .eq('status', 'queued')
    .eq('type', 'execute_intent')
    .order('created_at', { ascending: true })
    .limit(5);

  if (error) {
    console.error('[FETCH_ERROR]', { message: error.message });
    return;
  }

  if (!jobs || jobs.length === 0) return;

  for (const job of jobs) {
    await handleJob(job);
  }
}

async function handleJob(job) {
  const jobId = job.id;

  try {
    console.log('[JOB_PROCESSING]', {
      jobId,
      intentId: job.intent_id || null,
      payload: job.payload || null
    });

    const { error: claimError } = await supabase
      .from('execution_jobs')
      .update({
        status: 'processing',
        claimed_by: 'direct-executor',
        claimed_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString()
      })
      .eq('id', jobId)
      .eq('status', 'queued');

    if (claimError) {
      console.error('[JOB_CLAIM_ERROR]', {
        jobId,
        message: claimError.message
      });
      await markFailed(jobId, {
        last_step: 'claim_failed',
        message: claimError.message,
        payload: job.payload || null
      });
      return;
    }

    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-secret': API_SECRET
      },
      body: JSON.stringify(job.payload)
    });

    const text = await res.text();

    if (res.status === 200 || res.status === 202) {
      console.log('[JOB_SUCCESS]', {
        jobId,
        status: res.status,
        body: text
      });

      const { error } = await supabase
        .from('execution_jobs')
        .update({
          status: 'completed',
          last_step: 'completed',
          last_error: null,
          heartbeat_at: new Date().toISOString()
        })
        .eq('id', jobId);

      if (error) {
        console.error('[JOB_COMPLETE_UPDATE_ERROR]', {
          jobId,
          message: error.message
        });
      }
      return;
    }

    if (res.status === 409) {
      console.log('[JOB_IDEMPOTENT]', {
        jobId,
        status: res.status,
        body: text
      });

      const { error } = await supabase
        .from('execution_jobs')
        .update({
          status: 'completed',
          last_step: 'completed_idempotent',
          last_error: safeJson({ status: res.status, body: text }),
          heartbeat_at: new Date().toISOString()
        })
        .eq('id', jobId);

      if (error) {
        console.error('[JOB_IDEMPOTENT_UPDATE_ERROR]', {
          jobId,
          message: error.message
        });
      }
      return;
    }

    console.error('[JOB_FAIL]', {
      jobId,
      status: res.status,
      body: text,
      payload: job.payload || null
    });

    await markFailed(jobId, {
      last_step: 'webhook_non_2xx',
      http_status: res.status,
      body: text,
      payload: job.payload || null
    });

  } catch (err) {
    console.error('[JOB_ERROR]', {
      jobId,
      message: err?.message || String(err),
      stack: err?.stack || null,
      payload: job.payload || null
    });

    await markFailed(jobId, {
      last_step: 'exception',
      message: err?.message || String(err),
      stack: err?.stack || null,
      payload: job.payload || null
    });
  }
}

async function loop() {
  while (true) {
    try {
      await processJobs();
    } catch (err) {
      console.error('[LOOP_ERROR]', {
        message: err?.message || String(err),
        stack: err?.stack || null
      });
    }
    await sleep(POLL_MS);
  }
}

loop().catch(err => {
  console.error('[DIRECT_EXECUTOR_FATAL]', {
    message: err?.message || String(err),
    stack: err?.stack || null
  });
  process.exit(1);
});
