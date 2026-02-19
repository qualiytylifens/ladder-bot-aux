// worker.js (CommonJS) — ladder-bot-aux
// Minimal Supabase-backed worker for execution_jobs.
// - Claims jobs via public.claim_execution_job(...)
// - Heartbeats via public.heartbeat_execution_job(...)
// - Executes "execute_intent" jobs by attempting a few RPCs (safe: no direct table writes here)
// - Finishes via public.finish_execution_job(...)
//
// REQUIRED ENVs (Railway provides them at runtime; no dotenv needed):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   WORKER_ENABLED=1
//   WORKER_ID=ladder-worker-1
//   WORKER_TYPES=execute_intent   (or JSON array like ["execute_intent"] or set-like {"execute_intent"})
// Optional:
//   POLL_MS=2000
//   HEARTBEAT_SECS=20
//   CLAIM_TYPES_MODE=auto | single | typed   (default auto)

const { createClient } = require("@supabase/supabase-js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mustEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") throw new Error(`Missing required env var: ${name}`);
  return v;
}

function parseWorkerTypes(raw) {
  const s = (raw || "").trim();
  if (!s) return [];

  // JSON array: ["execute_intent","other"]
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(String).map((x) => x.trim()).filter(Boolean);
    } catch (_) {}
  }

  // set-ish: {"execute_intent"} or {execute_intent}
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((x) => x.replace(/['"]/g, "").trim())
      .filter(Boolean);
  }

  // single or csv: execute_intent or execute_intent,other
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

async function rpcOrThrow(sb, fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) {
    const msg = `[RPC:${fn}] ${error.message || error.toString()}`;
    const e = new Error(msg);
    e._sb = error;
    throw e;
  }
  return data;
}

async function safeHeartbeat(sb, jobId, workerId, runId, step) {
  try {
    await rpcOrThrow(sb, "heartbeat_execution_job", {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_run_id: runId,
      p_step: step || null,
    });
  } catch (e) {
    // Heartbeat failures should not crash the worker loop
    console.log(`${nowIso()} [heartbeat] failed: ${e.message}`);
  }
}

async function finishJob(sb, jobId, status, err) {
  // finish_execution_job(job_id uuid, new_status text, err text) returns void
  await rpcOrThrow(sb, "finish_execution_job", {
    job_id: jobId,
    new_status: status,
    err: err || null,
  });
}

async function claimJob(sb, workerId, types) {
  // Two overloads exist:
  // - claim_execution_job(text) -> jsonb
  // - claim_execution_job(text, text[]) -> jsonb
  //
  // We'll prefer typed claim when types are provided.
  const mode = (process.env.CLAIM_TYPES_MODE || "auto").toLowerCase();

  if (types && types.length > 0 && (mode === "auto" || mode === "typed")) {
    const data = await rpcOrThrow(sb, "claim_execution_job", {
      p_worker_id: workerId,
      p_types: types,
    });
    return data;
  }

  if (mode === "single" || mode === "auto") {
    const data = await rpcOrThrow(sb, "claim_execution_job", {
      p_worker_id: workerId,
    });
    return data;
  }

  // fallback
  const data = await rpcOrThrow(sb, "claim_execution_job", {
    p_worker_id: workerId,
  });
  return data;
}

async function executeIntentJob(sb, claimed) {
  // claimed looks like:
  // { id, type, run_id, payload: { action, symbol, intent_id } }
  const jobId = claimed.id;
  const runId = claimed.run_id;
  const payload = claimed.payload || {};
  const intentId = payload.intent_id;

  if (!intentId) {
    throw new Error("execute_intent job payload missing intent_id");
  }

  // ✅ SAFEST PATH:
  // Attempt existing RPC(s) that YOUR schema might already have.
  // If none exist, we fail the job with a clear error (no table writes here).
  //
  // Add your real executor RPC name here when you decide it:
  // e.g. "execute_intent_worker" or "process_execute_intent"
  const candidates = [
    // Most likely names (you can keep/adjust):
    { fn: "execute_intent_worker", args: { p_intent_id: intentId, p_run_id: runId, p_worker_id: process.env.WORKER_ID } },
    { fn: "process_execute_intent", args: { p_intent_id: intentId, p_run_id: runId, p_worker_id: process.env.WORKER_ID } },
    { fn: "execute_intent", args: { p_intent_id: intentId, p_run_id: runId, p_worker_id: process.env.WORKER_ID } },

    // Generic fallback signature:
    { fn: "execute_intent", args: { intent_id: intentId, run_id: runId, worker_id: process.env.WORKER_ID } },
  ];

  let lastErr = null;

  for (const c of candidates) {
    try {
      await safeHeartbeat(sb, jobId, process.env.WORKER_ID, runId, `exec_try:${c.fn}`);
      await rpcOrThrow(sb, c.fn, c.args);
      await safeHeartbeat(sb, jobId, process.env.WORKER_ID, runId, `exec_ok:${c.fn}`);
      return { ok: true, fn: c.fn };
    } catch (e) {
      lastErr = e;
      const msg = e.message || String(e);
      // If function doesn't exist, try next candidate.
      // Postgres error for missing function often includes "does not exist".
      const missing = /does not exist|undefined function|42883/i.test(msg);
      console.log(`${nowIso()} [execute_intent] ${c.fn} failed: ${msg}`);
      if (!missing) break; // other errors: stop and surface it
    }
  }

  throw lastErr || new Error("execute_intent failed (no executor RPC found)");
}

async function main() {
  const enabled = String(process.env.WORKER_ENABLED || "1").trim();
  if (enabled === "0" || enabled.toLowerCase() === "false") {
    console.log(`${nowIso()} [AUX] WORKER_DISABLED by env WORKER_ENABLED=${enabled}`);
    process.exit(0);
  }

  const SUPABASE_URL = mustEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_KEY = mustEnv("SUPABASE_SERVICE_KEY");

  const WORKER_ID = (process.env.WORKER_ID || "ladder-worker-1").trim();
  const types = parseWorkerTypes(process.env.WORKER_TYPES || "execute_intent");

  const POLL_MS = Math.max(250, parseInt(process.env.POLL_MS || "2000", 10));
  const HEARTBEAT_SECS = Math.max(5, parseInt(process.env.HEARTBEAT_SECS || "20", 10));
  const HEARTBEAT_MS = HEARTBEAT_SECS * 1000;

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  console.log(
    `${nowIso()} [AUX] WORKER STARTED`,
    JSON.stringify({ WORKER_ID, TYPES: types, POLL_MS, HEARTBEAT_SECS })
  );

  let stopping = false;
  process.on("SIGTERM", () => (stopping = true));
  process.on("SIGINT", () => (stopping = true));

  while (!stopping) {
    let claimedEnvelope = null;

    try {
      claimedEnvelope = await claimJob(sb, WORKER_ID, types);
    } catch (e) {
      console.log(`${nowIso()} [claim] error: ${e.message}`);
      await sleep(POLL_MS);
      continue;
    }

    const claimed = claimedEnvelope && claimedEnvelope.claimed ? claimedEnvelope.claimed : null;

    if (!claimed) {
      await sleep(POLL_MS);
      continue;
    }

    const jobId = claimed.id;
    const runId = claimed.run_id;

    console.log(`${nowIso()} [job] claimed`, JSON.stringify({ jobId, type: claimed.type, runId, payload: claimed.payload }));

    // Heartbeat tick for this job while we work
    let hbTimer = setInterval(() => {
      safeHeartbeat(sb, jobId, WORKER_ID, runId, "working").catch(() => {});
    }, HEARTBEAT_MS);

    try {
      await safeHeartbeat(sb, jobId, WORKER_ID, runId, "claimed_ok");

      if (claimed.type === "execute_intent") {
        const res = await executeIntentJob(sb, claimed);
        console.log(`${nowIso()} [job] execute_intent done`, JSON.stringify({ jobId, runId, via: res.fn }));
      } else {
        throw new Error(`Unsupported job type: ${claimed.type}`);
      }

      await finishJob(sb, jobId, "completed", null);
      console.log(`${nowIso()} [job] finished completed`, JSON.stringify({ jobId, runId }));
    } catch (e) {
      const err = (e && e.message) ? e.message : String(e);
      console.log(`${nowIso()} [job] failed`, JSON.stringify({ jobId, runId, err }));
      try {
        await finishJob(sb, jobId, "failed", err.slice(0, 500));
      } catch (finishErr) {
        console.log(`${nowIso()} [finish] error: ${finishErr.message}`);
      }
    } finally {
      clearInterval(hbTimer);
      hbTimer = null;
    }

    // Small pause between jobs so we don't hammer DB
    await sleep(250);
  }

  console.log(`${nowIso()} [AUX] worker stopping`);
}

main().catch((e) => {
  console.log(`${nowIso()} [AUX] fatal: ${e.message || e}`);
  process.exit(1);
});
