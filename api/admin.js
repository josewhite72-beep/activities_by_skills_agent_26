const crypto = require('crypto');

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

function noCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
}

async function r(cmd) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return (await res.json()).result;
}

const get = async k => { const v = await r(['GET', k]); return v ? JSON.parse(v) : null; };
const set = async (k, v) => r(['SET', k, JSON.stringify(v)]);
const members = async () => (await r(['SMEMBERS', 'idx:docentes'])) || [];
const addIdx = t => r(['SADD', 'idx:docentes', t]);

module.exports = async (req, res) => {
  noCacheHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'No autorizado' });

  const { action, token: reqToken } = req.query;
  const method = req.method;

  try {
    // GET ?action=list
    if (method === 'GET' && action === 'list') {
      const tokens = await members();
      const docs = await Promise.all(tokens.map(t => get(`t:${t}`)));
      return res.status(200).json(docs.filter(Boolean));
    }

    // GET ?action=stats
    if (method === 'GET' && action === 'stats') {
      const tokens = await members();
      const hoy = new Date().toISOString().split('T')[0];
      const mes = hoy.substring(0, 7);
      let totalHoy = 0, totalMes = 0, totalLogs = 0;
      for (const t of tokens) {
        const d = await get(`t:${t}`);
        if (d) {
          const u = await get(`u:${d.id}`);
          if (u) { totalHoy += u.diario?.[hoy]||0; totalMes += u.mensual?.[mes]||0; totalLogs += u.logs?.length||0; }
        }
      }
      return res.status(200).json({ totalHoy, totalMes, totalLogs, docentes: tokens.length });
    }

    // GET ?action=logs&token=xxx
    if (method === 'GET' && action === 'logs' && reqToken) {
      const d = await get(`t:${reqToken}`);
      if (!d) return res.status(404).json({ error: 'No encontrado' });
      const uso = await get(`u:${d.id}`);
      return res.status(200).json(uso || { logs: [], diario: {}, mensual: {} });
    }

    // POST ?action=create
    if (method === 'POST' && action === 'create') {
      const { nombre, email, limites, expira } = req.body;
      if (!nombre || !email) return res.status(400).json({ error: 'nombre y email requeridos' });
      const token = crypto.randomBytes(24).toString('hex');
      const id = crypto.randomBytes(8).toString('hex');
      const doc = {
        id, nombre, email, token, activo: true,
        creado: new Date().toISOString(), expira: expira || null,
        limites: { diario: limites?.diario ?? 20, mensual: limites?.mensual ?? 200 },
      };
      await set(`t:${token}`, doc);
      await addIdx(token);
      return res.status(200).json(doc);
    }

    // POST ?action=toggle&token=xxx
    if (method === 'POST' && action === 'toggle' && reqToken) {
      const doc = await get(`t:${reqToken}`);
      if (!doc) return res.status(404).json({ error: 'No encontrado' });
      const updated = { ...doc, ...req.body };
      await set(`t:${reqToken}`, updated);
      return res.status(200).json(updated);
    }

    return res.status(400).json({ error: 'Acción no válida' });

  } catch(e) {
    console.error(e.message);
    return res.status(500).json({ error: e.message });
  }
};
