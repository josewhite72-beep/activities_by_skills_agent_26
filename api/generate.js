// api/generate.js — Vercel Serverless Function
// Proxy seguro: recibe requests de docentes, valida, loguea, reenvía a DeepSeek

const CONFIG = {
  defaultDailyLimit: 20,
  defaultMonthlyLimit: 200,
  maxTokensAllowed: 4000,
  allowedModel: "deepseek-chat",
};

// Vercel KV store (usando fetch directo a Vercel KV REST API)
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const data = await res.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return data.result; }
}

async function kvSet(key, value) {
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { accessToken, messages, max_tokens, skillContext, gradeContext } = req.body;

    // 1. Verificar token
    const docente = await verificarToken(accessToken);
    if (!docente) return res.status(401).json({ error: 'Token inválido o expirado' });

    // 2. Verificar límites
    const limiteCheck = await verificarLimites(docente);
    if (!limiteCheck.ok) return res.status(429).json({ error: limiteCheck.mensaje, uso: limiteCheck.uso });

    // 3. Validar messages
    if (!messages || !Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: 'messages requerido' });

    // 4. Llamar a DeepSeek
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

    // 5. Registrar uso
    await registrarUso(docente, {
      timestamp: new Date().toISOString(),
      tokens: resultado.usage?.total_tokens || 0,
      skill: skillContext || '?',
      grade: gradeContext || '?',
    });

    return res.status(200).json(resultado);

  } catch (error) {
    console.error('Error proxy:', error);
    return res.status(500).json({ error: 'Error interno' });
  }
}

async function verificarToken(token) {
  if (!token) return null;
  try {
    const data = await kvGet(`token:${token}`);
    if (!data || data.activo === false) return null;
    if (data.expira && new Date(data.expira) < new Date()) return null;
    return data;
  } catch { return null; }
}

async function verificarLimites(docente) {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const mes = hoy.substring(0, 7);
    const uso = (await kvGet(`uso:${docente.id}`)) || { diario: {}, mensual: {} };
    const usoDiario = uso.diario?.[hoy] || 0;
    const usoMensual = uso.mensual?.[mes] || 0;
    const ld = docente.limites?.diario ?? CONFIG.defaultDailyLimit;
    const lm = docente.limites?.mensual ?? CONFIG.defaultMonthlyLimit;
    if (usoDiario >= ld) return { ok: false, mensaje: `Daily limit reached (${usoDiario}/${ld})` };
    if (usoMensual >= lm) return { ok: false, mensaje: `Monthly limit reached (${usoMensual}/${lm})` };
    return { ok: true, uso: { usoDiario, usoMensual, ld, lm } };
  } catch { return { ok: true, uso: {} }; }
}

async function registrarUso(docente, meta) {
  try {
    const hoy = meta.timestamp.split('T')[0];
    const mes = hoy.substring(0, 7);
    const uso = (await kvGet(`uso:${docente.id}`)) || { diario: {}, mensual: {}, logs: [] };
    uso.diario[hoy] = (uso.diario[hoy] || 0) + 1;
    uso.mensual[mes] = (uso.mensual[mes] || 0) + 1;
    uso.logs = uso.logs || [];
    uso.logs.push({ ...meta, docente: docente.nombre });
    if (uso.logs.length > 500) uso.logs = uso.logs.slice(-500);
    await kvSet(`uso:${docente.id}`, uso);
  } catch (e) { console.error('Log error:', e); }
}
