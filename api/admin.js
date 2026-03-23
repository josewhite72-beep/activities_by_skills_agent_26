// api/admin.js — Vercel Serverless Function
const crypto = require('crypto');

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// No-cache headers
function setNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

async function redis(command) {
  if (!KV_URL || !KV_TOKEN) throw new Error('Missing Upstash environment variables');
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

async function kvGet(key) {
  const result = await redis(['GET', key]);
  if (!result) return null;
  try { return JSON.parse(result); } catch { return result; }
}

async function kvSet(key, value) {
  return await redis(['SET', key, JSON.stringify(value)]);
}

// Use Redis Set index instead of KEYS
async function addToIndex(token) {
  await redis(['SADD', 'docentes:index', token]);
}

async function getAllTokens() {
  const result = await redis(['SMEMBERS', 'docentes:index']);
  return result || [];
}

async function removeFromIndex(token) {
  await redis(['SREM', 'docentes:index', token]);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  setNoCacheHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();

  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'No autorizado' });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.pathname.replace('/api/admin', '') || '/';
  const method = req.headers['x-method'] || req.method;

  try {
    // GET /docentes
    if (method === 'GET' && path === '/docentes') {
      const tokens = await getAllTokens();
      const docentes = await Promise.all(tokens.map(t => kvGet(`token:${t}`)));
      return res.status(200).json(docentes.filter(Boolean));
    }

    // POST /docentes
    if (method === 'POST' && path === '/docentes') {
      const { nombre, email, limites, expira } = req.body;
      if (!nombre || !email) return res.status(400).json({ error: 'nombre y email requeridos' });
      const token = crypto.randomBytes(24).toString('hex');
      const id = crypto.randomBytes(8).toString('hex');
      const docente = {
        id, nombre, email, token, activo: true,
        creado: new Date().toISOString(),
        expira: expira || null,
        limites: { diario: limites?.diario ?? 20, mensual: limites?.mensual ?? 200 },
      };
      await kvSet(`token:${token}`, docente);
      await addToIndex(token);
      return res.status(200).json({ ...docente, mensaje: `Token: ${token}` });
    }

    // PATCH /docentes/:token
    if (method === 'PATCH' && path.startsWith('/docentes/')) {
      const token = path.split('/')[2];
      const docente = await kvGet(`token:${token}`);
      if (!docente) return res.status(404).json({ error: 'No encontrado' });
      const actualizado = { ...docente, ...req.body, token };
      await kvSet(`token:${token}`, actualizado);
      return res.status(200).json(actualizado);
    }

    // DELETE /docentes/:token
    if (method === 'DELETE' && path.startsWith('/docentes/')) {
      const token = path.split('/')[2];
      const docente = await kvGet(`token:${token}`);
      if (!docente) return res.status(404).json({ error: 'No encontrado' });
      await kvSet(`token:${token}`, { ...docente, activo: false });
      return res.status(200).json({ mensaje: 'Docente desactivado' });
    }

    // GET /logs/:id
    if (method === 'GET' && path.startsWith('/logs/')) {
      const id = path.split('/')[2];
      const uso = await kvGet(`uso:${id}`);
      return res.status(200).json(uso || { logs: [], diario: {}, mensual: {} });
    }

    // GET /stats
    if (method === 'GET' && path === '/stats') {
      const tokens = await getAllTokens();
      const hoy = new Date().toISOString().split('T')[0];
      const mes = hoy.substring(0, 7);
      let totalHoy = 0, totalMes = 0, totalLogs = 0;
      const docentes = await Promise.all(tokens.map(t => kvGet(`token:${t}`)));
      for (const d of docentes.filter(Boolean)) {
        const uso = await kvGet(`uso:${d.id}`);
        if (uso) {
          totalHoy += uso.diario?.[hoy] || 0;
          totalMes += uso.mensual?.[mes] || 0;
          totalLogs += uso.logs?.length || 0;
        }
      }
      return res.status(200).json({ totalHoy, totalMes, totalLogs, docentes: tokens.length });
    }

    return res.status(404).json({ error: 'Ruta no encontrada' });

  } catch(e) {
    console.error('Admin error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
