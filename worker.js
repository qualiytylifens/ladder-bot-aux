'use strict';

/**
 * ladder-bot-aux / ladder-worker
 * Supabase execution_jobs poller that POSTs to BOT_WEBHOOK_URL
 *
 * - CommonJS (matches package.json "type":"commonjs")
 * - NO dotenv (Railway provides env vars)
 * - Strong logs (institutional observability)
 */

const { createClient } = require('@supabase/supabase-js');

function envBool(name, def = false) {
  const v = process.env[name];
  if (v == null) return def;
  return String(v).toLowerCase() === 'true' || String(v) === '1';
}

function envInt(name, def) {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function parseWorkerTypes(raw) {
  // Accept: execute_intent
  // Accept: execute_intent,foo
  // Accept JSON: ["execute_intent"]
  // Accept JSON: {"execute_intent":true} (we take keys)
  if (!raw) return ['execute_intent'];

  const s = String(raw).trim();

  // JSON array
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(String).map(x => x.trim()).filter(Boolean);
    } catch (_) {}
  }

  // JSON object
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return Object.keys(obj).map(String).map(x => x.trim()).filter(Boolean);
      }
    } catch (_) {}
  }

  // CSV
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

function jlog(tag, obj) {
  try {
    const ts = new Date().toISOString();
    console.log(`[AUX] ${ts} ${JSON.stringify({ tag, ...obj })}`);
  } catch (e) {
    console.log('[AUX] log_error', e?.message || e);
  }
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function httpPostJson(url, body, headers = {}) {
  // Node 20 has global fetch
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text };
}

async function main() {
  const WORKER_ENABLED = envBool('WORKER_ENABLED', true);
  const WORKER_ID = (process.env.WORKER_ID || 'ladder-worker-1').trim();
  const TYPES = parseWorkerTypes(process.env.WORKER_TYPES);
  const POLL_MS = envInt('POLL_MS', 2000);
  const HEARTBEAT_SECS = envInt('HEARTBEAT_SECS', 20);
  const JOB_TIMEOUT_MS = envInt('JOB_TIMEOUT_MS', 60000);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const BOT_WEBHOOK_URL = process.env.BOT_WEBHOOK_URL; // should be POST endpoint
  const API_SECRET = process.env.API_SECRET || ''; // optional shared secret

  const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
  const hasWebhook = Boolean(BOT_WEBHOOK_URL);

  jlog('WORKER_STARTED', {
    msg: 'WORKER_STARTED',
    WORKER_ENABLED,
    WORKER_ID,
    TYPES,
    POLL_MS,
    HEARTBEAT_SECS,
    JOB_TIMEOUT_MS,
    hasSupabase,
    hasWebhook,
  });

  if (!WORKER_ENABLED) {
    jlog('WORKER_DISABLED_BY_ENV', { msg: 'WORKER_DISABLED_BY_ENV' });
    return;
  }

  if (!hasSupabase) {
    jlog('FATAL', { msg: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY' });
    process.exit(1);
  }

  if (!hasWebhook) {
    jlog('FATAL', { msg: 'Missing BOT_WEBHOOK_URL (worker has nowhere to POST jobs)' });
    process.exit(1);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // Optional auth header to ladder-bot
  const webhookHeaders = {};
  if (API_SECRET) webhookHeaders['x-api-secret'] = API_SECRET;

  // Poll loop
  while (true) {
    try {
      jlog('POLL', { msg: 'POLL', types: TYPES });

      // Claim a job
      const { data: claim, error: claimErr } = await sb.rpc('claim_execution_job', {
        p_worker_id: WORKER_ID,
        p_types: TYPES,
      });

      if (claimErr) {
        jlog('CLAIM_ERR', { msg: 'CLAIM_ERR', error: claimErr.message || String(claimErr) });
        await sleep(POLL_MS);
        continue;
      }

      const claimed = claim && claim.claimed ? claim.claimed : null;

      if (!claimed) {
        await sleep(POLL_MS);
        continue;
      }

      const jobId = claimed.id;
      const runId = claimed.run_id;
      const payload = claimed.payload || {};
      const type = claimed.type || 'unknown';

      jlog('CLAIMED', { msg: 'CLAIMED', jobId, runId, type, payload });

      // Heartbeat starter (keeps db from thinking it is stale while we work)
      const hbStopAt = Date.now() + JOB_TIMEOUT_MS;
      let hbRunning = true;

      const hbLoop = (async () => {
        while (hbRunning) {
          try {
            await sb.rpc('heartbeat_execution_job', {
              p_job_id: jobId,
              p_worker_id: WORKER_ID,
              p_run_id: runId,
              p_step: 'executing',
            });
          } catch (e) {
            jlog('HEARTBEAT_ERR', { msg: 'HEARTBEAT_ERR', jobId, err: e?.message || String(e) });
          }
          await sleep(Math.max(1000, HEARTBEAT_SECS * 1000));
          if (Date.now() > hbStopAt) break;
        }
      })();

      // Execute by calling ladder-bot webhook
      const execBody = {
        job_id: jobId,
        run_id: runId,
        type,
        payload,
      };

      const resp = await httpPostJson(BOT_WEBHOOK_URL, execBody, webhookHeaders);

      hbRunning = false;
      await hbLoop.catch(() => {});

      if (!resp.ok) {
        const err = `webhook_failed_http_${resp.status}`;
        jlog('WEBHOOK_FAIL', { msg: 'WEBHOOK_FAIL', jobId, status: resp.status, text: resp.text?.slice(0, 300) });
        await sb.rpc('finish_execution_job', { job_id: jobId, new_status: 'failed', err });
        continue;
      }

      jlog('WEBHOOK_OK', { msg: 'WEBHOOK_OK', jobId, status: resp.status });
      await sb.rpc('finish_execution_job', { job_id: jobId, new_status: 'completed', err: null });

    } catch (e) {
      jlog('LOOP_ERR', { msg: 'LOOP_ERR', err: e?.message || String(e) });
      await sleep(POLL_MS);
    }
  }
}

main().catch((e) => {
  console.error('[AUX] fatal', e);
  process.exit(1);
});
