/**
 * DIRECT EXECUTOR (V4 LIVE)
 */

const { createClient } = require('@supabase/supabase-js');

if (typeof fetch !== 'function') {
  throw new Error('Global fetch is not available');
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_SECRET = process.env.API_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const POLL_MS = parseInt(process.env.EXECUTOR_POLL_MS || '3000', 10);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('[DIRECT_EXECUTOR_BOOT] starting...');

async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function processJobs(){
  const { data: jobs } = await supabase
    .from('execution_jobs')
    .select('*')
    .eq('status','queued')
    .limit(5);

  if(!jobs) return;

  for(const job of jobs){
    const id = job.id;

    await supabase.from('execution_jobs').update({
      status:'processing',
      claimed_by:'direct-executor',
      heartbeat_at:new Date().toISOString()
    }).eq('id',id);

    const res = await fetch(WEBHOOK_URL,{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-secret':API_SECRET
      },
      body: JSON.stringify(job.payload)
    });

    if(res.status===200 || res.status===202 || res.status===409){
      await supabase.from('execution_jobs').update({
        status:'completed'
      }).eq('id',id);
    } else {
      await supabase.from('execution_jobs').update({
        status:'failed'
      }).eq('id',id);
    }
  }
}

async function loop(){
  while(true){
    await processJobs();
    await sleep(POLL_MS);
  }
}

loop();
