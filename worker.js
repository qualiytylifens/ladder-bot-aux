import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const WORKER_ID = process.env.WORKER_ID || "aux-1";
const TYPES = (process.env.WORKER_TYPES || "execute_intent").split(",");

console.log("AUX WORKER STARTED", { WORKER_ID, TYPES });

async function claim() {
  const { data, error } = await sb.rpc("claim_execution_job", {
    p_worker_id: WORKER_ID,
    p_types: TYPES
  });

  if (error) {
    console.log("claim error", error.message);
    return null;
  }

  if (!data?.claimed) return null;

  return data.claimed;
}

async function heartbeat(job) {
  await sb.rpc("heartbeat_execution_job", {
    p_job_id: job.id,
    p_worker_id: WORKER_ID,
    p_run_id: job.run_id,
    p_step: "working"
  });
}

async function finish(job, status, err=null) {
  await sb.rpc("finish_execution_job", {
    job_id: job.id,
    new_status: status,
    err
  });
}

async function handle(job) {
  console.log("EXECUTING", job.payload);

  // 🚨 THIS IS WHERE ladder-bot USED TO DO IT
  // For now we simulate success
  await new Promise(r => setTimeout(r, 2000));

  await finish(job, "completed");
}

async function loop() {
  while(true) {
    try {
      const job = await claim();

      if (!job) {
        await new Promise(r=>setTimeout(r,1000));
        continue;
      }

      console.log("CLAIMED", job.id);

      const hb = setInterval(()=>heartbeat(job), 5000);

      try {
        await handle(job);
      } catch(e) {
        await finish(job, "failed", e.message);
      }

      clearInterval(hb);

    } catch(e) {
      console.log("loop error", e);
      await new Promise(r=>setTimeout(r,2000));
    }
  }
}

loop();
