// Pruebas del validador que corre en n8n antes de distribuir. Uso: node tests/test-validador.js
const assert = require('assert');
const L = require('../src/lib/clasificacion.js');

const ctx = { hoy: '2026-11-16', hora: '23:30', texto_original: 'texto de prueba' };
let ok = 0;
function prueba(nombre, fn) { fn(); ok++; console.log('✔', nombre); }
const reg = (o) => Object.assign({ id_local: 'r1', titulo: 'x', contenido: 'algo', fecha: null, hora: null, prioridad: null,
  estado: null, proyecto: null, etiquetas: [], confianza: 0.9, requiere_confirmacion: false }, o);
const salida = (registros, extra = {}) => JSON.stringify(Object.assign({ transcripcion_original: 'MODIFICADA', transcripcion_corregida: 'Texto corregido.',
  resumen_general: 'Resumen', registros, requiere_aclaracion: false, pregunta_aclaracion: null }, extra));

prueba('JSON inválido → revisión con la transcripción completa (no se pierde nada)', () => {
  const v = L.validarSalida('esto no es json', ctx);
  assert.strictEqual(v.valido, false);
  assert.strictEqual(v.registros[0].categoria_destino, 'revision');
  assert.strictEqual(v.registros[0].registro.contenido, 'texto de prueba');
});

prueba('JSON envuelto en ```json``` se recupera', () => {
  const v = L.validarSalida('```json\n' + salida([reg({ categoria: 'tarea' })]) + '\n```', ctx);
  assert.strictEqual(v.registros[0].categoria_destino, 'tarea');
});

prueba('La transcripción original es siempre la real, no la del modelo', () => {
  const v = L.validarSalida(salida([reg({ categoria: 'idea' })]), ctx);
  assert.strictEqual(v.transcripcion_original, 'texto de prueba');
  assert.strictEqual(v.transcripcion_corregida, 'Texto corregido.');
});

prueba('Categorías en plural / con tildes se normalizan; desconocidas van a revisión', () => {
  const v = L.validarSalida(salida([reg({ categoria: 'Conocimientos' }), reg({ categoria: 'compra' })]), ctx);
  assert.strictEqual(v.registros[0].categoria_destino, 'conocimiento');
  assert.strictEqual(v.registros[1].categoria_destino, 'revision');
  assert.strictEqual(v.registros[1].registro.tipo_revision, 'categoria');
});

prueba('Recordatorio sin hora → revisión con pregunta de aclaración', () => {
  const v = L.validarSalida(salida([reg({ categoria: 'recordatorio', titulo: 'Llamar al dentista', fecha: '2026-11-17' })]), ctx);
  const r = v.registros[0];
  assert.strictEqual(r.categoria_destino, 'revision');
  assert.strictEqual(r.registro.tipo_revision, 'aclaracion');
  assert.match(r.registro.pregunta, /la hora/);
});

prueba('Recordatorio relativo ("en dos horas") calcula fecha y hora, cruzando medianoche', () => {
  const v = L.validarSalida(salida([reg({ categoria: 'recordatorio', desplazamiento_minutos: 120 })]), ctx);
  assert.strictEqual(v.registros[0].categoria_destino, 'recordatorio');
  assert.strictEqual(v.registros[0].registro.fecha, '2026-11-17');
  assert.strictEqual(v.registros[0].registro.hora, '01:30');
});

prueba('Evento sin fecha no se crea: va a revisión', () => {
  const v = L.validarSalida(salida([reg({ categoria: 'evento', titulo: 'Reunión' })]), ctx);
  assert.strictEqual(v.registros[0].categoria_destino, 'revision');
});

prueba('Evento con fecha y sin hora es válido (todo el día)', () => {
  const v = L.validarSalida(salida([reg({ categoria: 'evento', fecha: '2026-11-21' })]), ctx);
  assert.strictEqual(v.registros[0].categoria_destino, 'evento');
  assert.strictEqual(v.registros[0].registro.hora, null);
});

prueba('Fechas y horas inválidas se descartan y se informa', () => {
  const v = L.validarSalida(salida([reg({ categoria: 'tarea', fecha: '2026-02-30', hora: '25:00' })]), ctx);
  assert.strictEqual(v.registros[0].registro.fecha, null);
  assert.ok(v.errores.length >= 2);
});

prueba('Hora "15.30" y "9" se normalizan', () => {
  assert.strictEqual(L.normalizarHora('15.30'), '15:30');
  assert.strictEqual(L.normalizarHora('9'), '09:00');
});

prueba('Confianza baja o requiere_confirmacion → revisión', () => {
  const v = L.validarSalida(salida([reg({ categoria: 'idea', confianza: 0.4 }), reg({ categoria: 'tarea', requiere_confirmacion: true })]), ctx);
  assert.deepStrictEqual(v.registros.map(r => r.categoria_destino), ['revision', 'revision']);
});

prueba('Reclasificación manual (categoría forzada) no vuelve a dudar', () => {
  const r = L.validarRegistro({ categoria: 'idea', titulo: 'x', contenido: 'y', confianza: 0.1 }, ctx, { categoriaForzada: true });
  assert.strictEqual(r.categoria_destino, 'idea');
  assert.strictEqual(r.registro.estado, 'nueva');
});

prueba('Sin registros → se archiva en "otros" (no se descarta)', () => {
  const v = L.validarSalida(salida([]), ctx);
  assert.strictEqual(v.registros[0].categoria_destino, 'otros');
});

prueba('Sin registros y con pregunta de aclaración → revisión', () => {
  const v = L.validarSalida(salida([], { requiere_aclaracion: true, pregunta_aclaracion: '¿Qué quisiste decir?' }), ctx);
  assert.strictEqual(v.registros[0].categoria_destino, 'revision');
  assert.strictEqual(v.registros[0].registro.pregunta, '¿Qué quisiste decir?');
});

prueba('Prioridad no mencionada queda null (no se inventa); estados se normalizan', () => {
  const v = L.validarSalida(salida([reg({ categoria: 'tarea', estado: 'En progreso' }), reg({ categoria: 'idea', estado: 'exploración' })]), ctx);
  assert.strictEqual(v.registros[0].registro.prioridad, null);
  assert.strictEqual(v.registros[0].registro.estado, 'en curso');
  assert.strictEqual(v.registros[1].registro.estado, 'en exploración');
});

prueba('Etiquetas: minúsculas, sin # ni duplicados', () => {
  const v = L.validarSalida(salida([reg({ categoria: 'otros', etiquetas: ['#Cabañas', 'cabañas', 'Wifi'] })]), ctx);
  assert.deepStrictEqual(v.registros[0].registro.etiquetas, ['cabañas', 'wifi']);
});

prueba('Calendario de referencia marca HOY y mañana con día de la semana', () => {
  const c = L.calendarioReferencia('2026-11-16');
  assert.match(c, /lunes 2026-11-16 \(HOY\)/);
  assert.match(c, /martes 2026-11-17 \(mañana\)/);
});

prueba('Esquema JSON incluye exactamente las 6 categorías', () => {
  assert.deepStrictEqual(L.esquemaSalida().properties.registros.items.properties.categoria.enum,
    ['tarea', 'recordatorio', 'evento', 'idea', 'conocimiento', 'otros']);
});

prueba('El ejemplo del prompt pasa la validación completa', () => {
  const fs = require('fs');
  const md = fs.readFileSync(require('path').join(__dirname, '../prompts/clasificador.md'), 'utf8');
  const json = md.slice(md.lastIndexOf('Salida:') + 7).trim();
  const v = L.validarSalida(json, { hoy: '2026-11-16', hora: '10:00', texto_original: 'x' });
  assert.strictEqual(v.valido, true, v.errores.join('; '));
  assert.deepStrictEqual(v.registros.map(r => r.categoria_destino), ['idea', 'tarea', 'evento', 'recordatorio']);
  assert.strictEqual(v.registros[3].registro.hora, '11:00');
});

console.log(`\n${ok} pruebas OK`);
