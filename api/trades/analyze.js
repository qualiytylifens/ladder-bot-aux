export default async function handler(req, res) {
  try {
    const timestamp = new Date().toISOString();
    const network = req.body?.event__network || 'UNKNOWN';
    
    console.log(`[${timestamp}] 🐋 WHALE ALERT RECEIVED`);
    console.log(`Network: ${network}`);
    console.log(`Body:`, JSON.stringify(req.body, null, 2));
    
    res.status(200).json({ 
      ok: true, 
      received: true,
      network: network
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
}
