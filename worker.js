// ladder-bot-aux execution worker
// purpose: claim jobs from Supabase and keep them alive

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const WORKER_ID = process.env.WORKER_ID || "ladder-worker-1";
const WORKER_TYPES = (process.env.WORKER_TYPES || "execute_intent").split(",");
const POLL_MS = Number(process.env.POLL_MS || 3000);
const HEARTBEAT_SECS = Number(process.env.HEARTBEAT_SECS || 15);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing Supabase credentials");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

console.log("AUX WORKER STARTED", {
  WORKER_ID,
  TYPES: WORKER_TYPES
});

let activeJobs = new Map();

/* -------------------------------------------------- */
/* HEARTBEAT LOOP                                     */
/* -------------------------------------------------- */
setInterval(async () => {
  for (const [jobId, job] of activeJobs.entries()) {
    try {
      await sb.rpc("heartbeat_execution_job", {
        p_job_id: jobId,
        p_worker_id: WORKER_ID,
        p_run_id: job.run_id,
        p_step: "alive"
      });
    } catch (err) {
      console.error("heartbeat failed", jobId, err.message);
    }
  }
}, HEARTBEAT_SECS * 1000);


/* -------------------------------------------------- */
/* CLAIM LOOP                                         */
/* -------------------------------------------------- */
async function poll() {
  try {
    const { data, error } = await sb.rpc("claim_execution_job", {
      p_worker_id: WORKER_ID,
      p_types: WORKER_TYPES
    });

    if (error) throw error;

    if (data && data.id) {
      console.log("CLAIMED JOB", data.id, data.payload);

      activeJobs.set(data.id, data);

      // simulate execution (your trading engine runs elsewhere)
      setTimeout(() => finishJob(data.id), 4000);
    }
  } catch (err) {
    console.error("poll error:", err.message);
  }

  setTimeout(poll, POLL_MS);
}


/* -------------------------------------------------- */
/* FINISH JOB                                         */
/* -------------------------------------------------- */
async function finishJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  try {
    await sb.rpc("finish_execution_job", {
      job_id: jobId,
      new_status: "completed",
      err: null
    });

    console.log("COMPLETED", jobId);
  } catch (err) {
    console.error("finish failed", jobId, err.message);
  }

  activeJobs.delete(jobId);
}

/* start */
poll();
