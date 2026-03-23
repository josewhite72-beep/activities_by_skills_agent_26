// api/admin.js — Vercel Serverless Function (Upstash Redis REST API)
const crypto = require('crypto');

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  try {
    const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const data = await res.json();
    if (!data.result) return null;
    try { return JSON.parse(data.result); } catch { return data.result; }
  } catch { return null; }
}

async function kvSet(key, value) {
  try {
    const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    return await res.json();
  } catch(e) { console.error('kvSet error:', e); }
}

async function kvKeys(prefix) {
  try {
    const res = await fetch(`${KV_URL}/keys/${encodeURIComponent(prefix + '*')}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const data = await res.json();
    return data.result || [];
  } catch { return []; }
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
    console.error(e);
    return res.status(500).json({ error: 'Error interno: ' + e.message });
  }
};
