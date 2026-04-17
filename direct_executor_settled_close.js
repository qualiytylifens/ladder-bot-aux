/**
 * ============================================
 * DIRECT EXECUTOR (V4 LIVE)
 * Supabase = brain
 * This service = dumb executor (muscle)
 * No webhook loop. No duplicate execution.
 * ============================================
 */

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// ENV
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_SECRET = process.env.API_SECRET;

// POLLING
const POLL_MS = parseInt(process.env.EXECUTOR_POLL_MS || '3000');

// INIT
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('[DIRECT_EXECUTOR_BOOT] starting...');

// ============================================
// MAIN LOOP
// ============================================

async function pollLoop() {
  while (true) {
    try {
      await processJobs();
    } catch (err) {
      console.error('[LOOP_ERROR]', err.message);
    }

    await sleep(POLL_MS);
  }
}

// ============================================
// PROCESS JOBS
// ============================================

async function processJobs() {
  const { data: jobs, error } = await supabase
    .from('execution_jobs')
    .select('*')
    .eq('status', 'queued')
    .limit(5);

  if (error) {
    console.error('[FETCH_ERROR]', error.message);
    return;
  }

  if (!jobs || jobs.length === 0) return;

  for (const job of jobs) {
    await handleJob(job);
  }
}

// ============================================
// HANDLE JOB
// ============================================

async function handleJob(job) {
  const jobId = job.id;

  try {
    console.log(`[JOB] processing ${jobId}`);

    // claim job
    await supabase
      .from('execution_jobs')
      .update({
        status: 'processing',
        claimed_by: 'direct-executor',
        heartbeat_at: new Date().toISOString()
      })
      .eq('id', jobId);

    // call ladder-bot webhook (execution layer)
    const res = await fetch(process.env.WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-secret': API_SECRET
      },
      body: JSON.stringify(job.payload)
    });

    const text = await res.text();

    // ============================================
    // HANDLE RESPONSE
    // ============================================

    if (res.status === 200 || res.status === 202) {
      console.log(`[JOB_SUCCESS] ${jobId}`);

      await supabase
        .from('execution_jobs')
        .update({
          status: 'completed',
          last_error: null
        })
        .eq('id', jobId);

      return;
    }

    if (res.status === 409) {
      console.log(`[JOB_IDEMPOTENT] ${jobId}`);

      // treat 409 as SUCCESS (critical fix)
      await supabase
        .from('execution_jobs')
        .update({
          status: 'completed',
          last_error: 'idempotent_conflict'
        })
        .eq('id', jobId);

      return;
    }

    // other errors
    console.error(`[JOB_FAIL] ${jobId}`, res.status, text);

    await supabase
      .from('execution_jobs')
      .update({
        status: 'failed',
        last_error: `http_${res.status}`
      })
      .eq('id', jobId);

  } catch (err) {
    console.error(`[JOB_ERROR] ${jobId}`, err.message);

    await supabase
      .from('execution_jobs')
      .update({
        status: 'failed',
        last_error: err.message
      })
      .eq('id', jobId);
  }
}

// ============================================
// UTIL
// ============================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// START
// ============================================

pollLoop();
