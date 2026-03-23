// api/admin.js — Vercel Serverless Function
const crypto = require('crypto');

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

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

async function kvSet(key, value) {
  const result = await redis(['SET', key, JSON.stringify(value)]);
  return result;
}

async function kvGet(key) {
  const result = await redis(['GET', key]);
  if (!result) return null;
  try { return JSON.parse(result); } catch { return result; }
}

async function kvKeys(prefix) {
  const result = await redis(['KEYS', prefix + '*']);
  return result || [];
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'No autorizado' });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.pathname.replace('/api/admin', '') || '/';
  const method = req.method;

  try {
    if (method === 'GET' && path === '/docentes') {
      const keys = await kvKeys('token:');
      const docentes = await Promise.all(keys.map(k => kvGet(k)));
      return res.status(200).json(docentes.filter(Boolean));
    }

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
      return res.status(200).json({ ...docente, mensaje: `Token: ${token}` });
    }

    if (method === 'PATCH' && path.startsWith('/docentes/')) {
      const token = path.split('/')[2];
      const docente = await kvGet(`token:${token}`);
      if (!docente) return res.status(404).json({ error: 'No encontrado' });
      const actualizado = { ...docente, ...req.body, token };
      await kvSet(`token:${token}`, actualizado);
      return res.status(200).json(actualizado);
    }

    if (method === 'DELETE' && path.startsWith('/docentes/')) {
      const token = path.split('/')[2];
      const docente = await kvGet(`token:${token}`);
      if (!docente) return res.status(404).json({ error: 'No encontrado' });
      await kvSet(`token:${token}`, { ...docente, activo: false });
      return res.status(200).json({ mensaje: 'Docente desactivado' });
    }

    if (method === 'GET' && path.startsWith('/logs/')) {
      const id = path.split('/')[2];
      const uso = await kvGet(`uso:${id}`);
      return res.status(200).json(uso || { logs: [], diario: {}, mensual: {} });
    }

    if (method === 'GET' && path === '/stats') {
      const keys = await kvKeys('uso:');
      const todos = await Promise.all(keys.map(k => kvGet(k)));
      const hoy = new Date().toISOString().split('T')[0];
      const mes = hoy.substring(0, 7);
      let totalHoy = 0, totalMes = 0, totalLogs = 0;
      todos.filter(Boolean).forEach(u => {
        totalHoy += u.diario?.[hoy] || 0;
        totalMes += u.mensual?.[mes] || 0;
        totalLogs += u.logs?.length || 0;
      });
      return res.status(200).json({ totalHoy, totalMes, totalLogs, docentes: keys.length });
    }

    return res.status(404).json({ error: 'Ruta no encontrada' });

  } catch(e) {
    console.error('Admin error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
