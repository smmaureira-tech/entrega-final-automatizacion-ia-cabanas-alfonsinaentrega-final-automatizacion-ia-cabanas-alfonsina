// Servidor falso que imita Telegram, Whisper y Ollama para probar los workflows sin servicios reales.
// Registra cada llamada a Telegram y la expone en GET /_log.
const http = require('http');
const fs = require('fs');
const path = require('path');
const L = require('../../src/lib/clasificacion.js');
const log = [];
let msgId = 1000;

const ej = fs.readFileSync(path.join(__dirname, '../../prompts/clasificador.md'), 'utf8');
const EJEMPLO = JSON.parse(ej.slice(ej.lastIndexOf('Salida:') + 7).trim());

function respuestaOllama(texto, hoy) {
  const base = { transcripcion_original: texto, transcripcion_corregida: texto, resumen_general: 'Prueba', requiere_aclaracion: false, pregunta_aclaracion: null };
  const r = o => Object.assign({ id_local: 'r1', titulo: 'x', contenido: 'x', fecha: null, hora: null, hora_fin: null, desplazamiento_minutos: null,
    prioridad: null, estado: null, proyecto: null, lugar: null, participantes: [], fuente: null, area_tematica: null, concepto_principal: null,
    aplicacion: null, etiquetas: [], relacionado_con: null, confianza: 0.9, requiere_confirmacion: false, pregunta: null }, o);
  if (/telescopio/.test(texto)) return EJEMPLO;
  if (/Mi respuesta: "mañana a las 10"/.test(texto)) {
    return { ...base, registros: [r({ categoria: 'recordatorio', titulo: 'Llamar al dentista', contenido: 'Llamar al dentista', fecha: L.sumarDias(hoy, 1), hora: '10:00' })] };
  }
  if (/dentista/.test(texto)) {
    return { ...base, registros: [r({ categoria: 'recordatorio', titulo: 'Llamar al dentista', contenido: 'Llamar al dentista', requiere_confirmacion: true, pregunta: '¿Qué día y a qué hora te aviso?' })] };
  }
  if (/basura/.test(texto)) return 'no soy json';
  return { ...base, registros: [r({ categoria: 'otros', titulo: 'Nota', contenido: texto })] };
}

http.createServer((req, res) => {
  let cuerpo = [];
  req.on('data', c => cuerpo.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(cuerpo);
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = req.url;
    if (u === '/_log') return json(log);
    if (u.startsWith('/api/chat')) {
      const b = JSON.parse(raw.toString());
      const contenido = b.messages[1].content;
      const hoy = (contenido.match(/HOY: \S+ (\d{4}-\d{2}-\d{2})/) || [])[1];
      const texto = contenido.split(/\n(?:MENSAJE|TRANSCRIPCIÓN DEL AUDIO):\n/)[1] || '';
      log.push({ api: 'ollama', texto, tiene_esquema: !!b.format, modelo: b.model });
      const out = respuestaOllama(texto, hoy);
      return json({ model: b.model, message: { role: 'assistant', content: typeof out === 'string' ? out : JSON.stringify(out) }, done: true });
    }
    if (u.startsWith('/asr')) {
      log.push({ api: 'whisper', bytes: raw.length, multipart: /audio_file/.test(raw.toString('latin1')) });
      return json({ text: 'eh se me ocurrió que podríamos hacer tours de observación de estrellas en las cabañas, mañana tengo que averiguar cuánto sale un telescopio. Ah y el jueves a las 11 tengo reunión con el contador. Recuérdame en una hora sacar la ropa' });
    }
    if (u.startsWith('/file/')) { res.writeHead(200, { 'content-type': 'audio/ogg' }); return res.end(Buffer.from('OggS-audio-falso')); }
    const m = u.match(/^\/bot[^/]+\/(\w+)/);
    if (m) {
      const metodo = m[1];
      let datos = {};
      try { datos = raw.length ? JSON.parse(raw.toString()) : {}; } catch (e) { datos = { raw: raw.toString() }; }
      if (metodo === 'getFile') return json({ ok: true, result: { file_id: 'x', file_path: 'voice/file_1.oga' } });
      log.push({ api: 'telegram', metodo, datos });
      if (metodo === 'sendMessage') return json({ ok: true, result: { message_id: ++msgId, chat: { id: datos.chat_id } } });
      return json({ ok: true, result: true });
    }
    json({ error: 'ruta desconocida ' + u }, 404);
  });
}).listen(8999, () => console.log('mock en :8999'));
