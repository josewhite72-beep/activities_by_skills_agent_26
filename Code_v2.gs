// ============================================================
// Activities By Skills Agent — Google Apps Script Backend
// Desarrollado por José R. White · Panamá
// ============================================================

const DEEPSEEK_API_KEY = 'sk-caa592db92b041e895d9299868560378';
const SHEET_NAME = 'Docentes';
const ADMIN_PASSWORD = 'CAMBIA_ESTA_CLAVE'; // ← cambia esto

// ── CORS & ROUTING ──────────────────────────────────────────
function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  const action = e.parameter.action || '';
  const adminKey = e.parameter.adminKey || '';
  
  try {
    // Public actions (no admin key needed)
    if (action === 'verify') return respond(verifyToken(e));
    if (action === 'generate') return respond(generateActivities(e));
    
    // Admin actions (require admin key)
    if (adminKey !== ADMIN_PASSWORD) 
      return respond({ error: 'No autorizado' }, 403);
    
    if (action === 'list') return respond(listDocentes());
    if (action === 'create') return respond(createDocente(e));
    if (action === 'toggle') return respond(toggleDocente(e));
    if (action === 'stats') return respond(getStats());
    if (action === 'logs') return respond(getLogs(e));
    
    return respond({ error: 'Acción no válida' }, 400);
    
  } catch(err) {
    return respond({ error: err.message }, 500);
  }
}

function respond(data, code) {
  const output = ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ── SHEET HELPERS ────────────────────────────────────────────
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, 9).setValues([[
      'ID', 'Nombre', 'Email', 'Token', 'Activo', 
      'Creado', 'Límite Diario', 'Límite Mensual', 'Expira'
    ]]);
    sheet.getRange(1, 1, 1, 9).setFontWeight('bold');
  }
  return sheet;
}

function getLogsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('Logs');
  if (!sheet) {
    sheet = ss.insertSheet('Logs');
    sheet.getRange(1, 1, 1, 6).setValues([[
      'Timestamp', 'Docente', 'Grado', 'Skill', 'Tokens', 'ID Docente'
    ]]);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
  }
  return sheet;
}

// ── VERIFY TOKEN ─────────────────────────────────────────────
function verifyToken(e) {
  const token = e.parameter.token || '';
  if (!token) return { valid: false, error: 'Token requerido' };
  
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[3] === token) {
      if (!row[4]) return { valid: false, error: 'Token desactivado' };
      
      // Check expiry
      if (row[8] && new Date(row[8]) < new Date()) 
        return { valid: false, error: 'Token expirado' };
      
      // Check daily limit
      const hoy = new Date().toISOString().split('T')[0];
      const logsSheet = getLogsSheet();
      const logs = logsSheet.getDataRange().getValues();
      const usoDiario = logs.filter(l => 
        l[5] === row[0] &&
        l[0].toString().includes(hoy)
      ).length;
      
      const limiteD = row[6] || 20;
      if (usoDiario >= limiteD) 
        return { valid: false, error: `Límite diario alcanzado (${usoDiario}/${limiteD})` };
      
      return { 
        valid: true, 
        nombre: row[1], 
        id: row[0],
        usoDiario,
        limiteD
      };
    }
  }
  return { valid: false, error: 'Token no encontrado' };
}

// ── GENERATE ACTIVITIES ──────────────────────────────────────
function generateActivities(e) {
  // Verify token first
  const verification = verifyToken(e);
  if (!verification.valid) return { error: verification.error };
  
  // Get data from URL parameters (works with cross-origin requests)
  let messages = [];
  let gradeContext = e.parameter.grade || '?';
  let skillContext = e.parameter.skill || '?';
  
  // Try POST body first, fallback to URL parameter
  try {
    if (e.postData && e.postData.contents) {
      const body = JSON.parse(e.postData.contents);
      messages = body.messages || [];
      gradeContext = body.gradeContext || gradeContext;
      skillContext = body.skillContext || skillContext;
    }
  } catch(err) {}
  
  // Fallback: build messages from prompt parameter
  if (!messages.length) {
    const prompt = e.parameter.prompt || '';
    if (!prompt) return { error: 'No prompt provided' };
    messages = [
      { role: 'system', content: 'You are an expert English language curriculum designer for Panama. Always respond with valid JSON only, no markdown, no extra text.' },
      { role: 'user', content: decodeURIComponent(prompt) }
    ];
  }
  
  if (!messages.length) return { error: 'Messages requerido' };
  
  // Call DeepSeek
  const response = UrlFetchApp.fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    },
    payload: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 4000,
      temperature: 0.7,
      messages
    }),
    muteHttpExceptions: true
  });
  
  const result = JSON.parse(response.getContentText());
  
  // Log usage
  if (result.choices) {
    logUsage(verification.id, verification.nombre, 
      gradeContext, skillContext,
      result.usage?.total_tokens || 0);
  }
  
  return result;
}

function logUsage(id, nombre, grade, skill, tokens) {
  const logsSheet = getLogsSheet();
  logsSheet.appendRow([
    new Date().toISOString(), nombre, grade, skill, tokens, id
  ]);
}

// ── ADMIN: LIST ───────────────────────────────────────────────
function listDocentes() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const docentes = [];
  
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    docentes.push({
      id: row[0], nombre: row[1], email: row[2],
      token: row[3], activo: row[4],
      creado: row[5], limiteD: row[6], limiteM: row[7],
      expira: row[8], row: i + 1
    });
  }
  return docentes;
}

// ── ADMIN: CREATE ─────────────────────────────────────────────
// FIXED: reads from e.parameter (GET params) instead of e.postData
function createDocente(e) {
  const nombre = e.parameter.nombre || '';
  const email = e.parameter.email || '';
  const limiteD = parseInt(e.parameter.limiteD) || 20;
  const limiteM = parseInt(e.parameter.limiteM) || 200;
  const expira = e.parameter.expira || '';
  
  if (!nombre || !email) return { error: 'Nombre y email requeridos' };
  
  const id = Utilities.getUuid().replace(/-/g,'').substring(0,16);
  const token = Utilities.getUuid().replace(/-/g,'') + 
                Utilities.getUuid().replace(/-/g,'');
  const creado = new Date().toISOString();
  
  const sheet = getSheet();
  sheet.appendRow([
    id, nombre, email, token, true,
    creado, limiteD, limiteM, expira
  ]);
  
  return { 
    success: true, id, nombre, email, token, 
    activo: true, creado, limiteD
  };
}

// ── ADMIN: TOGGLE ─────────────────────────────────────────────
// FIXED: reads from e.parameter (GET params) instead of e.postData
function toggleDocente(e) {
  const token = e.parameter.token || '';
  const activo = e.parameter.activo === 'true';
  
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (data[i][3] === token) {
      sheet.getRange(i + 1, 5).setValue(activo);
      return { success: true, activo };
    }
  }
  return { error: 'Docente no encontrado' };
}

// ── ADMIN: STATS ──────────────────────────────────────────────
function getStats() {
  const hoy = new Date().toISOString().split('T')[0];
  const mes = hoy.substring(0, 7);
  
  const logsSheet = getLogsSheet();
  const logs = logsSheet.getDataRange().getValues().slice(1);
  
  const totalHoy = logs.filter(l => l[0].toString().includes(hoy)).length;
  const totalMes = logs.filter(l => l[0].toString().includes(mes)).length;
  
  const sheet = getSheet();
  const docentes = sheet.getDataRange().getValues().slice(1)
    .filter(r => r[0]).length;
  
  return { totalHoy, totalMes, totalLogs: logs.length, docentes };
}

// ── ADMIN: LOGS ───────────────────────────────────────────────
function getLogs(e) {
  const id = e.parameter.id || '';
  const logsSheet = getLogsSheet();
  const logs = logsSheet.getDataRange().getValues().slice(1);
  
  const filtered = logs
    .filter(l => !id || l[5] === id)
    .slice(-100)
    .reverse()
    .map(l => ({
      timestamp: l[0], nombre: l[1], grade: l[2],
      skill: l[3], tokens: l[4]
    }));
  
  return filtered;
}
