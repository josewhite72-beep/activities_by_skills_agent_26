// netlify/functions/admin.js
// Panel de administración: crear tokens, ver logs, ajustar límites

const { getStore } = require("@netlify/blobs");
const crypto = require("crypto");

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  // Proteger con clave de admin (variable de entorno ADMIN_SECRET)
  const adminKey = event.headers["x-admin-key"];
  if (adminKey !== process.env.ADMIN_SECRET) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "No autorizado" }) };
  }

  const path   = event.path.replace("/.netlify/functions/admin", "") || "/";
  const method = event.httpMethod;
  const store  = getStore("docentes");

  try {
    // GET /docentes — listar todos los docentes
    if (method === "GET" && path === "/docentes") {
      const { blobs } = await store.list({ prefix: "token:" });
      const docentes = await Promise.all(
        blobs.map(b => store.get(b.key, { type: "json" }))
      );
      return ok(docentes.filter(Boolean), headers);
    }

    // POST /docentes — crear nuevo docente + token
    if (method === "POST" && path === "/docentes") {
      const body = JSON.parse(event.body || "{}");
      const { nombre, email, limites, expira } = body;
      if (!nombre || !email) return err(400, "nombre y email requeridos", headers);

      const token = crypto.randomBytes(24).toString("hex");
      const id    = crypto.randomBytes(8).toString("hex");
      const docente = {
        id, nombre, email, token,
        activo: true,
        creado: new Date().toISOString(),
        expira: expira || null,
        limites: {
          diario:   limites?.diario  ?? 20,
          mensual:  limites?.mensual ?? 200,
        },
      };
      await store.setJSON("token:" + token, docente);
      return ok({ ...docente, mensaje: "Docente creado. Comparte este token:" + token }, headers);
    }

    // PATCH /docentes/:token — actualizar límites o estado
    if (method === "PATCH" && path.startsWith("/docentes/")) {
      const token = path.split("/")[2];
      const docente = await store.get("token:" + token, { type: "json" });
      if (!docente) return err(404, "Docente no encontrado", headers);

      const body = JSON.parse(event.body || "{}");
      const actualizado = { ...docente, ...body, token }; // no sobreescribir token
      await store.setJSON("token:" + token, actualizado);
      return ok(actualizado, headers);
    }

    // DELETE /docentes/:token — desactivar (no borrar, para conservar logs)
    if (method === "DELETE" && path.startsWith("/docentes/")) {
      const token = path.split("/")[2];
      const docente = await store.get("token:" + token, { type: "json" });
      if (!docente) return err(404, "Docente no encontrado", headers);
      await store.setJSON("token:" + token, { ...docente, activo: false });
      return ok({ mensaje: "Docente desactivado" }, headers);
    }

    // GET /logs/:id — ver logs de un docente
    if (method === "GET" && path.startsWith("/logs/")) {
      const id = path.split("/")[2];
      const uso = await store.get("uso:" + id, { type: "json" });
      if (!uso) return ok({ logs: [], diario: {}, mensual: {} }, headers);
      return ok(uso, headers);
    }

    // GET /stats — resumen general
    if (method === "GET" && path === "/stats") {
      const { blobs } = await store.list({ prefix: "uso:" });
      const todos = await Promise.all(blobs.map(b => store.get(b.key, { type: "json" })));
      const hoy = new Date().toISOString().split("T")[0];
      const mes  = hoy.substring(0, 7);
      let totalHoy = 0, totalMes = 0, totalLogs = 0;
      todos.filter(Boolean).forEach(u => {
        totalHoy  += u.diario?.[hoy]   || 0;
        totalMes  += u.mensual?.[mes]  || 0;
        totalLogs += u.logs?.length    || 0;
      });
      return ok({ totalHoy, totalMes, totalLogs, docentes: blobs.length }, headers);
    }

    return err(404, "Ruta no encontrada", headers);

  } catch (e) {
    console.error(e);
    return err(500, "Error interno: " + e.message, headers);
  }
};

const ok  = (body, h) => ({ statusCode: 200, headers: h, body: JSON.stringify(body) });
const err = (s, msg, h) => ({ statusCode: s, headers: h, body: JSON.stringify({ error: msg }) });
