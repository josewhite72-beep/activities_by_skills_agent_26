// api/debug.js — TEMPORARY diagnostic endpoint
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function r(cmd) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return (await res.json());
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  try {
    // Test 1: Check connection
    const ping = await r(['PING']);
    
    // Test 2: Check index
    const index = await r(['SMEMBERS', 'idx:docentes']);
    
    // Test 3: Check all keys with token prefix
    const keys = await r(['KEYS', 't:*']);

    return res.status(200).json({
      ping: ping.result,
      index: index.result,
      keys: keys.result,
      KV_URL: KV_URL ? KV_URL.substring(0, 30) + '...' : 'MISSING',
      KV_TOKEN: KV_TOKEN ? 'SET' : 'MISSING',
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
