#!/usr/bin/env node
/*
 * Genera los workflows importables de n8n (carpeta n8n/) a partir de:
 *   - src/lib/clasificacion.js  (validador, se incrusta en los nodos Code)
 *   - src/nodos/*.js            (código de cada nodo Code)
 *   - prompts/clasificador.md   (prompt de sistema del clasificador)
 * Uso: node tools/build-workflows.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RAIZ = path.join(__dirname, '..');
const leer = p => fs.readFileSync(path.join(RAIZ, p), 'utf8');
const LIB = leer('src/lib/clasificacion.js').replace(/\nif \(typeof module[\s\S]*$/, '\n');
const PROMPT = leer('prompts/clasificador.md');
const nodoJs = n => leer(`src/nodos/${n}.js`);
const conLib = (n, extra = '') => `${LIB}\n${extra}\n// ---- nodo ----\n${nodoJs(n)}`;

const CRED = {
  postgres: { postgres: { id: 'asistPostgres001', name: 'Postgres Asistente' } },
  telegram: { telegramApi: { id: 'asistTelegram001', name: 'Telegram Asistente' } },
  gcal: { googleCalendarOAuth2Api: { id: 'asistGCal0000001', name: 'Google Calendar Asistente' } },
};
const uuid = semilla => {
  const h = crypto.createHash('sha1').update(semilla).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function nuevoWorkflow(id, nombre) {
  const nodos = [];
  const conexiones = {};
  const w = {
    nodo(nombreNodo, type, typeVersion, parameters, pos, extra = {}) {
      nodos.push(Object.assign({ id: uuid(id + nombreNodo), name: nombreNodo, type, typeVersion, position: pos, parameters }, extra));
      return nombreNodo;
    },
    // conectar('A', 'B') o conectar('A', 'B', salida)
    conectar(a, b, salida = 0) {
      conexiones[a] = conexiones[a] || { main: [] };
      while (conexiones[a].main.length <= salida) conexiones[a].main.push([]);
      conexiones[a].main[salida].push({ node: b, type: 'main', index: 0 });
    },
    json() {
      return {
        id, name: nombre, active: false, nodes: nodos, connections: conexiones,
        settings: { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
        pinData: {}, meta: { templateCredsSetupCompleted: false }, tags: [],
      };
    },
  };
  return w;
}

/* ---------- Fábricas de nodos ---------- */
const code = (w, nombre, js, pos, modo = 'runOnceForAllItems') =>
  w.nodo(nombre, 'n8n-nodes-base.code', 2, { mode: modo, language: 'javaScript', jsCode: js }, pos);

const sql = (w, nombre, query, params, pos, extra = {}) =>
  w.nodo(nombre, 'n8n-nodes-base.postgres', 2.5, {
    operation: 'executeQuery', query,
    options: params ? { queryReplacement: `={{ ${params} }}` } : {},
  }, pos, Object.assign({ credentials: CRED.postgres }, extra));

const TG_BASE = "{{ $env.TELEGRAM_API_URL || 'https://api.telegram.org' }}";
const TG = `${TG_BASE}/bot{{ $env.TELEGRAM_BOT_TOKEN }}`;
// Envío por la API oficial de Telegram (permite HTML, botones y "responder a este mensaje").
const tgEnviar = (w, nombre, cuerpo, pos, extra = {}) =>
  w.nodo(nombre, 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: `=${TG}/sendMessage`, sendBody: true, specifyBody: 'json',
    jsonBody: `={{ JSON.stringify(${cuerpo}) }}`, options: {},
  }, pos, Object.assign({ retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }, extra));
const mensaje = (chat, texto, teclado) =>
  `{ chat_id: ${chat}, text: String(${texto}).slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: ${teclado} || undefined }`;

const switchPor = (w, nombre, campo, valores, pos) =>
  w.nodo(nombre, 'n8n-nodes-base.switch', 3.2, {
    rules: {
      values: valores.map(v => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{ id: uuid(nombre + v), leftValue: `={{ $json.${campo} }}`, rightValue: v, operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        renameOutput: true, outputKey: v,
      })),
    },
    options: {},
  }, pos);

const siVerdadero = (w, nombre, expr, pos) =>
  w.nodo(nombre, 'n8n-nodes-base.if', 2.2, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: uuid(nombre), leftValue: `={{ ${expr} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    },
    options: {},
  }, pos);

const nota = (w, nombre, texto, pos, ancho = 380, alto = 260, color = 7) =>
  w.nodo(nombre, 'n8n-nodes-base.stickyNote', 1, { content: texto, width: ancho, height: alto, color }, pos);

const CAL = { __rl: true, value: "={{ $env.GOOGLE_CALENDAR_ID || 'primary' }}", mode: 'id' };

/* =====================================================================
 * WORKFLOW 1 · Entrada de Telegram: captura → Whisper → Ollama → validación → Switch → destinos
 * ===================================================================== */
function workflowEntrada() {
  const w = nuevoWorkflow('asistTdahEntrada', 'Asistente TDAH · 1 Entrada Telegram y clasificación');

  nota(w, 'Nota · Cómo funciona', '## 🧠 Entrada y clasificación\n1. Llega un audio, texto, comando o botón desde Telegram.\n2. Audio → Whisper local → texto.\n3. Ollama local clasifica en 6 categorías y devuelve JSON.\n4. **Validar JSON** revisa estructura, fechas y reglas antes de distribuir.\n5. **Distribuir por categoría** (Switch) envía cada registro a su destino.\n6. Al final se envía UNA confirmación con lo creado y dónde quedó.', [-200, -460], 520, 260, 4);
  nota(w, 'Nota · Orden', '**Importante:** este workflow usa el orden de ejecución v1. La rama del Switch (arriba) termina completa antes de que corra "Una sola vez" (abajo), por eso la confirmación ve todos los registros.', [2200, 700], 420, 160, 3);

  w.nodo('Telegram Trigger', 'n8n-nodes-base.telegramTrigger', 1.1,
    { updates: ['message', 'callback_query'], additionalFields: {} }, [0, 300],
    { webhookId: uuid('tg-webhook'), credentials: CRED.telegram });
  code(w, 'Clasificar entrada', nodoJs('entrada'), [220, 300]);
  w.conectar('Telegram Trigger', 'Clasificar entrada');
  switchPor(w, 'Tipo de entrada', 'tipo', ['voz', 'texto', 'comando', 'boton', 'configurar'], [440, 280]);
  w.conectar('Clasificar entrada', 'Tipo de entrada');

  // --- Audio → Whisper
  w.nodo('Telegram · ubicar audio', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: `=${TG}/getFile?file_id={{ $json.file_id }}`, options: {},
  }, [700, 0]);
  w.nodo('Telegram · descargar audio', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'GET', url: `=${TG_BASE}/file/bot{{ $env.TELEGRAM_BOT_TOKEN }}/{{ $json.result.file_path }}`,
    options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
  }, [920, 0]);
  w.nodo('Whisper · transcribir', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: "={{ $env.WHISPER_URL || 'http://whisper:9000' }}/asr?task=transcribe&language=es&output=json&encode=true&vad_filter=true",
    sendBody: true, contentType: 'multipart-form-data',
    bodyParameters: { parameters: [{ parameterType: 'formBinaryData', name: 'audio_file', inputDataFieldName: 'data' }] },
    options: { timeout: 600000 },
  }, [1140, 0], { retryOnFail: true, maxTries: 2 });
  code(w, 'Texto desde audio', nodoJs('texto_audio'), [1360, 0]);
  w.conectar('Tipo de entrada', 'Telegram · ubicar audio', 0);
  w.conectar('Telegram · ubicar audio', 'Telegram · descargar audio');
  w.conectar('Telegram · descargar audio', 'Whisper · transcribir');
  w.conectar('Whisper · transcribir', 'Texto desde audio');

  // --- Texto (o respuesta a una pregunta de revisión)
  sql(w, '¿Responde a una pregunta?', 'SELECT preparar_aclaracion($1::bigint, $2::text) AS r',
    '[ $json.reply_to, $json.texto ]', [700, 200]);
  code(w, 'Texto desde mensaje', nodoJs('texto_mensaje'), [920, 200]);
  w.conectar('Tipo de entrada', '¿Responde a una pregunta?', 1);
  w.conectar('¿Responde a una pregunta?', 'Texto desde mensaje');

  // --- Clasificación con Ollama
  code(w, 'Preparar prompt', conLib('preparar_prompt', `const PROMPT_SISTEMA = ${JSON.stringify(PROMPT)};`), [1580, 100]);
  w.conectar('Texto desde audio', 'Preparar prompt');
  w.conectar('Texto desde mensaje', 'Preparar prompt');
  w.nodo('Telegram · escribiendo…', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: `=${TG}/sendChatAction`, sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ chat_id: $json.chat_id, action: 'typing' }) }}", options: {},
  }, [1800, 100], { onError: 'continueRegularOutput' });
  w.nodo('Ollama · clasificar', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: "={{ $env.OLLAMA_URL || 'http://ollama:11434' }}/api/chat",
    sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify($('Preparar prompt').first().json.ollama_body) }}",
    options: { timeout: 600000 },
  }, [2020, 100], { retryOnFail: true, maxTries: 2, waitBetweenTries: 3000 });
  code(w, 'Validar JSON', conLib('validar'), [2240, 100]);
  sql(w, 'Guardar captura', 'SELECT guardar_captura($1::jsonb) AS captura_id', '[ JSON.stringify($json.captura) ]', [2460, 100]);
  code(w, 'Expandir registros', nodoJs('expandir'), [2680, 100]);
  w.conectar('Preparar prompt', 'Telegram · escribiendo…');
  w.conectar('Telegram · escribiendo…', 'Ollama · clasificar');
  w.conectar('Ollama · clasificar', 'Validar JSON');
  w.conectar('Validar JSON', 'Guardar captura');
  w.conectar('Guardar captura', 'Expandir registros');

  // --- Distribución (Switch con las 6 categorías + revisión)
  const CATS = ['tarea', 'recordatorio', 'evento', 'idea', 'conocimiento', 'otros', 'revision'];
  switchPor(w, 'Distribuir por categoría', 'categoria_destino', CATS, [2940, -60]);
  w.conectar('Expandir registros', 'Distribuir por categoría');
  const item = '[ JSON.stringify($json) ]';
  const X = 3240, Y0 = -560, DY = 170;
  sql(w, 'Guardar tarea', 'SELECT guardar_tarea($1::jsonb) AS r', item, [X, Y0]);
  sql(w, 'Programar recordatorio', 'SELECT guardar_recordatorio($1::jsonb) AS r', item, [X, Y0 + DY]);
  code(w, 'Preparar evento', conLib('preparar_evento'), [X, Y0 + 2 * DY]);
  w.nodo('Google Calendar · crear evento', 'n8n-nodes-base.googleCalendar', 1.3, {
    calendar: CAL, start: '={{ $json.gcal.inicio }}', end: '={{ $json.gcal.fin }}', useDefaultReminders: true,
    additionalFields: {
      summary: '={{ $json.gcal.titulo }}', description: '={{ $json.gcal.descripcion }}',
      location: '={{ $json.gcal.lugar }}', allday: '={{ $json.gcal.todoElDia }}',
    },
  }, [X + 220, Y0 + 2 * DY], { credentials: CRED.gcal, onError: 'continueRegularOutput' });
  sql(w, 'Guardar evento', 'SELECT guardar_evento($1::jsonb) AS r',
    "[ JSON.stringify(Object.assign({}, $('Preparar evento').item.json, { google_event_id: $json.id || null, google_link: $json.htmlLink || null, calendar_error: $json.error ? JSON.stringify($json.error).slice(0, 300) : null })) ]",
    [X + 440, Y0 + 2 * DY]);
  sql(w, 'Guardar idea', 'SELECT guardar_idea($1::jsonb) AS r', item, [X, Y0 + 3 * DY]);
  sql(w, 'Guardar conocimiento', 'SELECT guardar_conocimiento($1::jsonb) AS r', item, [X, Y0 + 4 * DY]);
  sql(w, 'Guardar en archivo general', 'SELECT guardar_otros($1::jsonb) AS r', item, [X, Y0 + 5 * DY]);
  sql(w, 'Guardar en revisión', 'SELECT guardar_revision($1::jsonb) AS r', item, [X, Y0 + 6 * DY]);
  tgEnviar(w, 'Telegram · preguntar', mensaje('$env.TELEGRAM_CHAT_ID', '$json.r.texto', '$json.r.teclado'), [X + 220, Y0 + 6 * DY]);
  sql(w, 'Registrar pregunta', 'SELECT registrar_msg_revision($1::int, $2::bigint)',
    "[ $('Guardar en revisión').item.json.r.id, $json.result.message_id ]", [X + 440, Y0 + 6 * DY]);
  ['Guardar tarea', 'Programar recordatorio', 'Preparar evento', 'Guardar idea', 'Guardar conocimiento',
    'Guardar en archivo general', 'Guardar en revisión'].forEach((n, i) => w.conectar('Distribuir por categoría', n, i));
  w.conectar('Preparar evento', 'Google Calendar · crear evento');
  w.conectar('Google Calendar · crear evento', 'Guardar evento');
  w.conectar('Guardar en revisión', 'Telegram · preguntar');
  w.conectar('Telegram · preguntar', 'Registrar pregunta');

  // --- Confirmación final (una vez, después de todas las ramas)
  code(w, 'Una sola vez', nodoJs('una_vez'), [2940, 520]);
  sql(w, 'Armar confirmación', 'SELECT confirmacion($1::jsonb) AS r', '[ JSON.stringify($json) ]', [3160, 520]);
  tgEnviar(w, 'Telegram · confirmación', mensaje('$env.TELEGRAM_CHAT_ID', '$json.r.texto', 'null'), [3380, 520]);
  w.conectar('Expandir registros', 'Una sola vez');
  w.conectar('Una sola vez', 'Armar confirmación');
  w.conectar('Armar confirmación', 'Telegram · confirmación');

  // --- Comandos y botones
  sql(w, 'Ejecutar comando', 'SELECT comando_telegram($1::text) AS r', '[ $json.texto ]', [700, 420]);
  sql(w, 'Ejecutar botón', 'SELECT accion_boton($1::text) AS r', '[ $json.callback_data ]', [700, 620]);
  w.nodo('Telegram · responder botón', 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST', url: `=${TG}/answerCallbackQuery`, sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ callback_query_id: $('Clasificar entrada').first().json.callback_id, text: String($json.r.texto || 'Listo').replace(/<[^>]+>/g, '').slice(0, 190) }) }}",
    options: {},
  }, [920, 620], { onError: 'continueRegularOutput' });
  code(w, 'Resultado de la acción', nodoJs('resultado_accion'), [1140, 520]);
  w.conectar('Tipo de entrada', 'Ejecutar comando', 2);
  w.conectar('Tipo de entrada', 'Ejecutar botón', 3);
  w.conectar('Ejecutar botón', 'Telegram · responder botón');
  // tras responder al botón, se usa el resultado de la base (no el de Telegram)
  w.conectar('Ejecutar comando', 'Resultado de la acción');
  code(w, 'Resultado del botón', "return [{ json: { r: $('Ejecutar botón').first().json.r } }];", [1140, 680]);
  w.conectar('Telegram · responder botón', 'Resultado del botón');
  w.conectar('Resultado del botón', 'Resultado de la acción');

  tgEnviar(w, 'Telegram · respuesta', mensaje('$json.chat_id', '$json.texto', '$json.teclado'), [1400, 420]);
  siVerdadero(w, '¿Quitar de Google Calendar?', "!!$('Resultado de la acción').first().json.eliminar_evento_google", [1400, 600]);
  w.nodo('Google Calendar · eliminar evento', 'n8n-nodes-base.googleCalendar', 1.3, {
    operation: 'delete', calendar: CAL, eventId: "={{ $('Resultado de la acción').first().json.eliminar_evento_google }}", options: {},
  }, [1620, 600], { credentials: CRED.gcal, onError: 'continueRegularOutput' });
  siVerdadero(w, '¿Reclasificar?', "!!$('Resultado de la acción').first().json.redistribuir", [1400, 780]);
  code(w, 'Registro reclasificado', conLib('reclasificado'), [1620, 780]);
  w.conectar('Resultado de la acción', 'Telegram · respuesta');
  w.conectar('Resultado de la acción', '¿Quitar de Google Calendar?');
  w.conectar('Resultado de la acción', '¿Reclasificar?');
  w.conectar('¿Quitar de Google Calendar?', 'Google Calendar · eliminar evento', 0);
  w.conectar('¿Reclasificar?', 'Registro reclasificado', 0);
  w.conectar('Registro reclasificado', 'Distribuir por categoría');
  w.conectar('Registro reclasificado', 'Una sola vez');

  // --- Primer uso: entrega el chat id
  tgEnviar(w, 'Telegram · configurar', mensaje('$json.chat_id',
    "'👋 Hola. Para activar tu asistente copia este número en TELEGRAM_CHAT_ID del archivo .env y reinicia n8n:\\n\\n<code>' + $json.chat_id + '</code>'", 'null'), [700, 820]);
  w.conectar('Tipo de entrada', 'Telegram · configurar', 4);
  return w.json();
}

/* =====================================================================
 * WORKFLOW 2 · Programación: recordatorios cada minuto + resúmenes de mañana, noche y domingo
 * ===================================================================== */
function workflowProgramado() {
  const w = nuevoWorkflow('asistTdahProgram', 'Asistente TDAH · 2 Recordatorios y resúmenes');
  nota(w, 'Nota · Programación', '## ⏰ Avisos automáticos\n- Cada minuto: envía los recordatorios vencidos (con botones Hecho / +1 h / Mañana) y vuelve a insistir hasta 2 veces si no los confirmas.\n- 08:00: plan del día + lo que quedó en el tintero.\n- 21:00: cierre del día.\n- Domingo 19:00: resumen semanal con rendimiento.\nHorarios en la zona de GENERIC_TIMEZONE.', [-260, -360], 480, 260, 4);

  w.nodo('Cada minuto', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } }, [0, 0]);
  sql(w, 'Tomar recordatorios vencidos', 'SELECT liberar_recordatorios_trabados(); SELECT r FROM reclamar_recordatorios() AS r;', null, [220, 0]);
  code(w, '¿Hay avisos?', 'return $input.all().filter(i => i.json && i.json.r && i.json.r.id);', [440, 0]);
  tgEnviar(w, 'Telegram · enviar recordatorio', mensaje('$env.TELEGRAM_CHAT_ID', '$json.r.texto', '$json.r.teclado'), [660, 0]);
  sql(w, 'Marcar enviado', 'SELECT marcar_recordatorio_enviado($1::int, $2::bigint)',
    "[ $('¿Hay avisos?').item.json.r.id, $json.result.message_id ]", [880, 0]);
  w.conectar('Cada minuto', 'Tomar recordatorios vencidos');
  w.conectar('Tomar recordatorios vencidos', '¿Hay avisos?');
  w.conectar('¿Hay avisos?', 'Telegram · enviar recordatorio');
  w.conectar('Telegram · enviar recordatorio', 'Marcar enviado');

  const resumen = (disparo, cron, fn, y) => {
    w.nodo(disparo, 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'cronExpression', expression: cron }] } }, [0, y]);
    const q = `Resumen · ${fn}`;
    sql(w, q, `SELECT ${fn}() AS r`, null, [220, y]);
    const env = `Telegram · ${fn}`;
    tgEnviar(w, env, mensaje('$env.TELEGRAM_CHAT_ID', '$json.r.texto', '$json.r.teclado'), [440, y]);
    w.conectar(disparo, q);
    w.conectar(q, env);
  };
  resumen('Mañana 08:00', '0 8 * * *', 'resumen_diario', 220);
  resumen('Noche 21:00', '0 21 * * *', 'resumen_noche', 400);
  resumen('Domingo 19:00', '0 19 * * 0', 'resumen_semanal', 580);
  return w.json();
}

/* =====================================================================
 * WORKFLOW 3 · API del panel semanal (la consume dashboard/index.html a través de nginx)
 * ===================================================================== */
function workflowPanel() {
  const w = nuevoWorkflow('asistTdahPanel01', 'Asistente TDAH · 3 API del panel semanal');
  nota(w, 'Nota · Panel', '## 📈 Panel semanal\nGET /webhook/panel?semana=0 devuelve los datos de la semana.\nPOST /webhook/panel-accion permite completar o reprogramar desde el panel.\nAmbos exigen la cabecera X-Panel-Token (la agrega nginx).', [-260, -300], 460, 200, 4);
  const token = "$json.headers['x-panel-token'] && $json.headers['x-panel-token'] === $env.PANEL_TOKEN";

  w.nodo('GET /panel', 'n8n-nodes-base.webhook', 2, { httpMethod: 'GET', path: 'panel', responseMode: 'responseNode', options: {} }, [0, 0], { webhookId: uuid('panel-get') });
  siVerdadero(w, 'Token válido (GET)', token, [220, 0]);
  sql(w, 'Datos del panel', 'SELECT panel_semanal($1::int) AS r', "[ Math.max(-52, Math.min(4, parseInt($json.query.semana || '0', 10) || 0)) ]", [440, -80]);
  const responder = (n, pos, cuerpo, codigo = 200) => w.nodo(n, 'n8n-nodes-base.respondToWebhook', 1.1, {
    respondWith: 'json', responseBody: cuerpo,
    options: { responseCode: codigo, responseHeaders: { entries: [{ name: 'Cache-Control', value: 'no-store' }] } },
  }, pos);
  responder('Responder panel', [660, -80], '={{ JSON.stringify($json.r) }}');
  responder('No autorizado (GET)', [440, 100], '={{ JSON.stringify({ error: "no autorizado" }) }}', 401);
  w.conectar('GET /panel', 'Token válido (GET)');
  w.conectar('Token válido (GET)', 'Datos del panel', 0);
  w.conectar('Token válido (GET)', 'No autorizado (GET)', 1);
  w.conectar('Datos del panel', 'Responder panel');

  w.nodo('POST /panel-accion', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'panel-accion', responseMode: 'responseNode', options: {} }, [0, 360], { webhookId: uuid('panel-post') });
  siVerdadero(w, 'Token válido (POST)', token, [220, 360]);
  sql(w, 'Acción del panel', 'SELECT accion_panel($1::jsonb) AS r', '[ JSON.stringify($json.body || {}) ]', [440, 280]);
  responder('Responder acción', [660, 280], '={{ JSON.stringify($json.r) }}');
  responder('No autorizado (POST)', [440, 460], '={{ JSON.stringify({ error: "no autorizado" }) }}', 401);
  w.conectar('POST /panel-accion', 'Token válido (POST)');
  w.conectar('Token válido (POST)', 'Acción del panel', 0);
  w.conectar('Token válido (POST)', 'No autorizado (POST)', 1);
  w.conectar('Acción del panel', 'Responder acción');
  return w.json();
}

const salida = path.join(RAIZ, 'n8n');
fs.mkdirSync(salida, { recursive: true });
const wfs = {
  '1-entrada-telegram.json': workflowEntrada(),
  '2-recordatorios-y-resumenes.json': workflowProgramado(),
  '3-api-panel.json': workflowPanel(),
};
for (const [archivo, wf] of Object.entries(wfs)) {
  fs.writeFileSync(path.join(salida, archivo), JSON.stringify(wf, null, 2) + '\n');
  console.log(`✔ n8n/${archivo} (${wf.nodes.length} nodos)`);
}
