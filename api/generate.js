// api/generate.js — Vercel Serverless Function
const CONFIG = {
  defaultDailyLimit: 20,
  defaultMonthlyLimit: 200,
  maxTokensAllowed: 4000,
  allowedModel: "deepseek-chat",
};

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
  return await redis(['SET', key, JSON.stringify(value)]);
}

async function kvGet(key) {
  const result = await redis(['GET', key]);
  if (!result) return null;
  try { return JSON.parse(result); } catch { return result; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { accessToken, messages, max_tokens, skillContext, gradeContext } = req.body;

    const docente = await verificarToken(accessToken);
    if (!docente) return res.status(401).json({ error: 'Token inválido o expirado' });

    const limiteCheck = await verificarLimites(docente);
    if (!limiteCheck.ok) return res.status(429).json({ error: limiteCheck.mensaje });

    if (!messages || !Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages requerido' });

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key no configurada' });

    const dsRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: CONFIG.allowedModel,
        max_tokens: Math.min(max_tokens || 4000, CONFIG.maxTokensAllowed),
        temperature: 0.7,
        messages,
      }),
    });

    const resultado = await dsRes.json();
    if (!dsRes.ok) return res.status(dsRes.status).json({ error: resultado.error?.message || 'API error' });

    await registrarUso(docente, {
      timestamp: new Date().toISOString(),
      tokens: resultado.usage?.total_tokens || 0,
      skill: skillContext || '?',
      grade: gradeContext || '?',
    }).catch(e => console.error('Log error:', e.message));

    return res.status(200).json(resultado);

  } catch(error) {
    console.error('Generate error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

async function verificarToken(token) {
  if (!token) return null;
  const data = await kvGet(`token:${token}`);
  if (!data || data.activo === false) return null;
  if (data.expira && new Date(data.expira) < new Date()) return null;
  return data;
}

async function verificarLimites(docente) {
  const hoy = new Date().toISOString().split('T')[0];
  const mes = hoy.substring(0, 7);
  const uso = (await kvGet(`uso:${docente.id}`)) || { diario: {}, mensual: {} };
  const usoDiario = uso.diario?.[hoy] || 0;
  const usoMensual = uso.mensual?.[mes] || 0;
  const ld = docente.limites?.diario ?? CONFIG.defaultDailyLimit;
  const lm = docente.limites?.mensual ?? CONFIG.defaultMonthlyLimit;
  if (usoDiario >= ld) return { ok: false, mensaje: `Daily limit reached (${usoDiario}/${ld})` };
  if (usoMensual >= lm) return { ok: false, mensaje: `Monthly limit reached (${usoMensual}/${lm})` };
  return { ok: true };
}

async function registrarUso(docente, meta) {
  const hoy = meta.timestamp.split('T')[0];
  const mes = hoy.substring(0, 7);
  const uso = (await kvGet(`uso:${docente.id}`)) || { diario: {}, mensual: {}, logs: [] };
  uso.diario[hoy] = (uso.diario[hoy] || 0) + 1;
  uso.mensual[mes] = (uso.mensual[mes] || 0) + 1;
  uso.logs = uso.logs || [];
  uso.logs.push({ ...meta, docente: docente.nombre });
  if (uso.logs.length > 500) uso.logs = uso.logs.slice(-500);
  await kvSet(`uso:${docente.id}`, uso);
}
