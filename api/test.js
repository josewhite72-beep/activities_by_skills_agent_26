// api/test.js — temporary endpoint to verify Upstash connection
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function redis(command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Redis ${res.status}: ${err.error || res.statusText}`);
  }
  const data = await res.json();
  return data.result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const setResult = await redis(['SET', 'test:ping', JSON.stringify({ ok: true, ts: Date.now() })]);
    const getResult = await redis(['GET', 'test:ping']);
    return res.status(200).json({
      success: true,
      setResult,
      getResult,
      KV_URL: KV_URL ? 'set' : 'MISSING',
      KV_TOKEN: KV_TOKEN ? 'set' : 'MISSING',
    });
  } catch(e) {
    return res.status(500).json({ error: e.message, KV_URL: KV_URL ? 'set' : 'MISSING', KV_TOKEN: KV_TOKEN ? 'set' : 'MISSING' });
  }
};
