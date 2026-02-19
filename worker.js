// worker.js (CommonJS)
const { createClient } = require("@supabase/supabase-js");

function mustGet(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v).trim();
}

function parseTypes(raw) {
  if (!raw) return ["execute_intent"];

  const s = String(raw).trim();

  // Accept JSON arrays if someone pastes them (["execute_intent"])
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(String).map(x => x.trim()).filter(Boolean);
    } catch (_) {}
  }

  // Accept comma-separated: execute_intent,other_type
  return s
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async function main() {
  const enabled = String(process.env.WORKER_ENABLED || "1").trim() === "1";
  if (!enabled) {
    console.log("[AUX] WORKER_DISABLED by env. Exiting.");
    process.exit(0);
  }

  const SUPABASE_URL = mustGet("SUPABASE_URL");
  const SUPABASE_SERVICE_KEY = mustGet("SUPABASE_SERVICE_KEY");

  const WORKER_ID = String(process.env.WORKER_ID || "ladder-worker-1").trim();
  const TYPES = parseTypes(process.env.WORKER_TYPES || "execute_intent");

  const POLL_MS = Number(process.env.POLL_MS || "2000");
  const HEARTBEAT_SECS = Number(process.env.HEARTBEAT_SECS || "20");

  console.log("[AUX] WORKER STARTED", { WORKER_ID, TYPES, POLL_MS, HEARTBEAT_SECS });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  });

  let hbTimer = null;

  async function heartbeatLoop(jobId, runId) {
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(async () => {
      try {
        await
