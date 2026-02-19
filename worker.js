// worker.js (ladder-bot-aux)
// Minimal execution_jobs worker: claims jobs, heartbeats, finishes.
// Node 18+ / 20+

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

function mustEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') throw new Error(`Missing env: ${name}`);
  return v;
}

function parseWorkerTypes(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  // Accept:
  //  - execute_intent
  //  - execute_intent,other
  //  - ["execute_intent"]
  //  - {"execute_intent"}  (user asked about this)
  //  - {execute_intent}
  //  - "execute_intent"
  let x = s;

  // strip surrounding quotes
  if ((x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'"))) {
    x = x.slice(1, -1);
  }

  // JSON array
  if (x.startsWith('[') && x.endsWith(']')) {
    try {
      const arr = JSON.parse(x);
      if (Array.isArray(arr)) return arr.map(String).map(t => t.trim()).filter(Boolean);
    } catch (_) {
      // fall through
    }
  }

  // Curly brace set-ish: {"execute_intent"} or {execute_intent}
  if (x.startsWith('{') && x.endsWith('}')) {
    x = x.slice(1, -1).trim();
    // remove quotes inside
    x = x.replaceAll('"', '').replaceAll("'", '');
    // split by comma
    return x.split(',').map(t => t.trim()).filter(Boolean);
  }

  // comma separated
  if (x.includes(',')) return x.split(',').map(t => t.trim()).filter(Boolean);

  // single token
  return [x.trim()].filter(Boolean);
}

const SUPABASE_URL = mustEnv('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = mustEnv('SUPABASE_SERVICE_KEY');

const WORKER_ENABLED = String(process.env.WORKER_ENABLED ?? '1').trim() !== '0';
const WORKER_ID = String(process.env.WORKER_ID ?? 'ladder-worker-1').trim();
const WORKER_TYPES = parseWorkerTypes(process.env.WORKER_TYPES ?? 'execute_intent');

const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const HEARTBEAT_SECS = Number(process.env.HEARTBEAT_SECS ?? 20);

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}

async function claimJob() {
  // There are 2 functions in your DB:
  // - claim_execution_job(text)
  // - claim_execution_job(text, text[])
  // We will ALWAYS call the 2-arg version to avoid "not unique" errors.
  const data = await rpc('claim_execution_job', {
    p_worker_id: WORKER_ID,
    p_types: WORKER_TYPES,
  });
  // expected: { claimed: {...} } or { claimed: null }
  return data?.claimed ?? null;
}

async function heartbeat(jobId, runId, step) {
  await rpc('heartbeat_execution_job', {
    p_job_id: jobId,
    p_worker_id: WORKER_ID,
    p_run_id: runId,
    p_step: step,
  });
}

async function finish(jobId, status, err) {
  await rpc('finish_execution_job', {
    job_id: jobId,
    new_status: status,
    err: err ?? null,
  });
}

async function handleExecuteIntent(job) {
  // Minimal: we only prove the pipeline works.
  // Your real "execute" happens in ladder-bot — this worker just closes the job cleanly.
  const intentId = job?.payload?.intent_id;
  const symbol = job?.payload?.symbol;
  const action = job?.payload?.action;

  // if any required field missing, fail fast so you see it
  if (!intentId || !symbol || !action) {
    throw new Error(`bad_payload: ${JSON.stringify(job?.payload ?? {})}`);
  }

  // If you want this worker to call tv-controller or ladder-bot webhook later, we can add,
  // but right now we keep it minimal & stable.
  return { ok: true, intent_id: intentId, symbol, action };
}

async function runOne(job) {
  const jobId = job.id;
  const runId = job.run_id;

  // heartbeat right away
  await heartbeat(jobId, runId, 'claimed');

  // keep heartbeating while we work
  let hbTimer = null;
  try {
    hbTimer = setInterval(() => {
      heartbeat(jobId, runId, 'working').catch(() => {});
    }, Math.max(5, HEARTBEAT_SECS) * 1000);

    if (job.type === 'execute_intent') {
      const res = await handleExecuteIntent(job);
      await heartbeat(jobId, runId, 'done');
      await finish(jobId, 'completed', null);
      console.log('[DONE]', { jobId, type: job.type, res });
      return;
    }

    // unknown type
    await finish(jobId, 'failed', `unknown_type:${job.type}`);
    console.log('[FAIL]', { jobId, type: job.type, err: 'unknown_type' });
  } finally {
    if (hbTimer) clearInterval(hbTimer);
  }
}

async function main() {
  if (!WORKER_ENABLED) {
    console.log('[AUX] WORKER_DISABLED by env');
    process.exit(0);
  }

  console.log('[AUX] WORKER STARTED', {
    WORKER_ID,
    TYPES: WORKER_TYPES,
    POLL_MS,
    HEARTBEAT_SECS,
  });

  // main loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const job = await claimJob();
      if (!job) {
        await sleep(POLL_MS);
        continue;
      }

      console.log('[AUX] CLAIMED', { id: job.id, type: job.type, run_id: job.run_id, payload: job.payload });
      await runOne(job);
    } catch (e) {
      console.error('[AUX] LOOP_ERROR', e?.message ?? e);
      await sleep(Math.max(1000, POLL_MS));
    }
  }
}

main().catch((e) => {
  console.error('[AUX] FATAL', e?.message ?? e);
  process.exit(1);
});
