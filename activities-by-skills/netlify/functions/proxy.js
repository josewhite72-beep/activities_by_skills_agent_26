// netlify/functions/proxy.js
// Proxy seguro: recibe requests de docentes, valida, loguea, reenvía a DeepSeek

const { getStore } = require("@netlify/blobs");

const CONFIG = {
  defaultDailyLimit: 20,
  defaultMonthlyLimit: 200,
  maxTokensAllowed: 4000,
  allowedModel: "deepseek-chat",
};

exports.handler = async (event) => {
  const headers = corsHeaders();

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Método no permitido" }, headers);
  }

  try {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return respond(400, { error: "Body inválido" }, headers); }

    const { accessToken, messages, max_tokens, skillContext, gradeContext } = body;

    // 1. Verificar token del docente
    const docente = await verificarToken(accessToken);
    if (!docente) {
      return respond(401, { error: "Token inválido o expirado" }, headers);
    }

    // 2. Verificar límites
    const limiteCheck = await verificarLimites(docente);
    if (!limiteCheck.ok) {
      return respond(429, { error: limiteCheck.mensaje, uso: limiteCheck.uso }, headers);
    }

    // 3. Validar request
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return respond(400, { error: "messages requerido" }, headers);
    }

    // 4. Llamar a DeepSeek (API key SOLO en servidor)
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return respond(500, { error: "Error de configuración" }, headers);

    const dsRes = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: CONFIG.allowedModel,
        max_tokens: Math.min(max_tokens || 4000, CONFIG.maxTokensAllowed),
        temperature: 0.7,
        messages,
      }),
    });

    const resultado = await dsRes.json();
    if (!dsRes.ok) {
      return respond(dsRes.status, { error: resultado.error?.message || "Error API" }, headers);
    }

    // 5. Registrar uso
    await registrarUso(docente, {
      timestamp: new Date().toISOString(),
      tokens: resultado.usage?.total_tokens || 0,
      skill: skillContext || "?",
      grade: gradeContext || "?",
    });

    return respond(200, resultado, headers);

  } catch (error) {
    console.error("Error proxy:", error);
    return respond(500, { error: "Error interno" }, headers);
  }
};

async function verificarToken(token) {
  if (!token) return null;
  try {
    const store = getStore("docentes");
    const data = await store.get("token:" + token, { type: "json" });
    if (!data || data.activo === false) return null;
    if (data.expira && new Date(data.expira) < new Date()) return null;
    return data;
  } catch { return null; }
}

async function verificarLimites(docente) {
  try {
    const store = getStore("docentes");
    const hoy = new Date().toISOString().split("T")[0];
    const mes  = hoy.substring(0, 7);
    const uso = (await store.get("uso:" + docente.id, { type: "json" })) || { diario: {}, mensual: {} };
    const usoDiario  = uso.diario[hoy]  || 0;
    const usoMensual = uso.mensual[mes] || 0;
    const lim = docente.limites || {};
    const ld = lim.diario   ?? CONFIG.defaultDailyLimit;
    const lm = lim.mensual  ?? CONFIG.defaultMonthlyLimit;
    if (usoDiario  >= ld) return { ok: false, mensaje: "Límite diario alcanzado (" + usoDiario + "/" + ld + ").", uso: { usoDiario, usoMensual, ld, lm } };
    if (usoMensual >= lm) return { ok: false, mensaje: "Límite mensual alcanzado (" + usoMensual + "/" + lm + ").", uso: { usoDiario, usoMensual, ld, lm } };
    return { ok: true, uso: { usoDiario, usoMensual, ld, lm } };
  } catch { return { ok: true, uso: {} }; }
}

async function registrarUso(docente, meta) {
  try {
    const store = getStore("docentes");
    const hoy = meta.timestamp.split("T")[0];
    const mes  = hoy.substring(0, 7);
    const key  = "uso:" + docente.id;
    const uso  = (await store.get(key, { type: "json" })) || { diario: {}, mensual: {}, logs: [] };
    uso.diario[hoy]  = (uso.diario[hoy]  || 0) + 1;
    uso.mensual[mes] = (uso.mensual[mes] || 0) + 1;
    uso.logs = uso.logs || [];
    uso.logs.push({ ...meta, docente: docente.nombre });
    if (uso.logs.length > 500) uso.logs = uso.logs.slice(-500);
    await store.setJSON(key, uso);
  } catch (e) { console.error("Log error:", e); }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

function respond(status, body, headers) {
  return { statusCode: status, headers, body: JSON.stringify(body) };
}
