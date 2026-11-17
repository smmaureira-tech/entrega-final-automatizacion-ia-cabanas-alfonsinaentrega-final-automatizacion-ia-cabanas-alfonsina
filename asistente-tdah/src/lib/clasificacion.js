/*
 * Lógica compartida del clasificador.
 * Este archivo se incrusta tal cual en los nodos Code de n8n (ver tools/build-workflows.js)
 * y también se prueba con Node (tests/test-validador.js). No usa dependencias externas.
 */

const CATEGORIAS = ['tarea', 'recordatorio', 'evento', 'idea', 'conocimiento', 'otros'];
const PRIORIDADES = ['alta', 'media', 'baja'];
const ESTADOS_TAREA = ['pendiente', 'en curso', 'completada'];
const ESTADOS_IDEA = ['nueva', 'en exploración', 'en desarrollo', 'descartada'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const UMBRAL_CONFIANZA = 0.6;

const pad2 = n => String(n).padStart(2, '0');

/* ---------- Fechas en la zona horaria del usuario (sin librerías) ---------- */

function ahoraEnZona(zona, base = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(base).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}

function sumarDias(fecha, n) {
  const [y, m, d] = fecha.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

function diaSemana(fecha) {
  const [y, m, d] = fecha.split('-').map(Number);
  return DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function sumarMinutos(fecha, hora, minutos) {
  const [y, m, d] = fecha.split('-').map(Number);
  const [h, mi] = hora.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, h, mi + minutos));
  return {
    fecha: `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`,
    hora: `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`,
  };
}

function fechaValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function normalizarHora(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2})[:.h](\d{2})?/i) || s.trim().match(/^(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] || 0);
  if (h > 23 || mi > 59) return null;
  return `${pad2(h)}:${pad2(mi)}`;
}

/* Calendario de referencia que se entrega al modelo: así no tiene que calcular fechas. */
function calendarioReferencia(hoy) {
  const filas = [];
  for (let i = -7; i <= 21; i++) {
    const f = sumarDias(hoy, i);
    let etiqueta = '';
    if (i === 0) etiqueta = ' (HOY)';
    else if (i === 1) etiqueta = ' (mañana)';
    else if (i === 2) etiqueta = ' (pasado mañana)';
    else if (i === -1) etiqueta = ' (ayer)';
    filas.push(`${diaSemana(f)} ${f}${etiqueta}`);
  }
  return filas.join('\n');
}

/* ---------- Normalización ---------- */

function sinTildes(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function normalizarCategoria(c) {
  const s = sinTildes(c);
  const mapa = {
    tarea: 'tarea', tareas: 'tarea', task: 'tarea',
    recordatorio: 'recordatorio', recordatorios: 'recordatorio', reminder: 'recordatorio',
    evento: 'evento', eventos: 'evento', compromiso: 'evento', compromisos: 'evento', cita: 'evento',
    idea: 'idea', ideas: 'idea',
    conocimiento: 'conocimiento', conocimientos: 'conocimiento', aprendizaje: 'conocimiento',
    otros: 'otros', otro: 'otros', 'otros temas': 'otros', archivo: 'otros',
  };
  return mapa[s] || null;
}

function normalizarEstadoIdea(e) {
  const s = sinTildes(e);
  if (s.startsWith('explor')) return 'en exploración';
  if (s.startsWith('desarroll') || s === 'en desarrollo') return 'en desarrollo';
  if (s.startsWith('descart')) return 'descartada';
  return 'nueva';
}

function normalizarEstadoTarea(e) {
  const s = sinTildes(e);
  if (s.includes('curso') || s.includes('progreso')) return 'en curso';
  if (s.startsWith('complet') || s === 'hecha' || s === 'terminada') return 'completada';
  return 'pendiente';
}

function textoONull(v, max = 4000) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || ['null', 'none', 'n/a', 'ninguno', 'ninguna', 'no especificado', 'no mencionado'].includes(s.toLowerCase())) return null;
  return s.slice(0, max);
}

function listaTextos(v, max = 10) {
  if (typeof v === 'string') v = v.split(/[,;]/);
  if (!Array.isArray(v)) return [];
  const vistos = new Set();
  const out = [];
  for (const x of v) {
    const t = textoONull(x, 60);
    if (!t) continue;
    const k = t.toLowerCase().replace(/^#/, '');
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

/* ---------- Lectura del JSON devuelto por Ollama ---------- */

function parsearJSON(texto) {
  if (texto && typeof texto === 'object') return { ok: true, valor: texto };
  const s = String(texto || '').trim();
  try { return { ok: true, valor: JSON.parse(s) }; } catch (e) { /* sigue */ }
  // Modelos pequeños a veces envuelven el JSON en ```json ... ``` o texto extra.
  const ini = s.indexOf('{'), fin = s.lastIndexOf('}');
  if (ini >= 0 && fin > ini) {
    try { return { ok: true, valor: JSON.parse(s.slice(ini, fin + 1)) }; } catch (e) { /* sigue */ }
  }
  return { ok: false, error: 'La respuesta del modelo no es un JSON válido' };
}

/* ---------- Validación de cada registro ---------- */

const PREGUNTA_CATEGORIA = '¿Dónde guardo esto? Elige una categoría.';

function aRevision(r, motivo, pregunta, tipo) {
  return {
    categoria_destino: 'revision',
    registro: Object.assign({}, r, {
      motivo_revision: motivo,
      pregunta: pregunta || r.pregunta || PREGUNTA_CATEGORIA,
      tipo_revision: tipo, // 'categoria' (botones) o 'aclaracion' (responder con texto)
    }),
  };
}

function validarRegistro(bruto, ctx, opciones = {}) {
  const errores = [];
  const r0 = bruto && typeof bruto === 'object' ? bruto : {};
  const categoriaOriginal = r0.categoria;
  const categoria = normalizarCategoria(r0.categoria);
  const contenido = textoONull(r0.contenido, 8000) || textoONull(r0.titulo, 8000) || '';
  const r = {
    categoria: categoria || 'otros',
    titulo: (textoONull(r0.titulo, 140) || contenido.slice(0, 80) || 'Sin título'),
    contenido,
    fecha: fechaValida(r0.fecha) ? r0.fecha : null,
    hora: normalizarHora(r0.hora),
    hora_fin: normalizarHora(r0.hora_fin),
    prioridad: PRIORIDADES.includes(sinTildes(r0.prioridad)) ? sinTildes(r0.prioridad) : null,
    estado: null,
    proyecto: textoONull(r0.proyecto, 120),
    etiquetas: listaTextos(r0.etiquetas),
    lugar: textoONull(r0.lugar, 200),
    participantes: listaTextos(r0.participantes, 20),
    fuente: textoONull(r0.fuente, 300),
    area_tematica: textoONull(r0.area_tematica, 120),
    aplicacion: textoONull(r0.aplicacion, 2000),
    concepto_principal: textoONull(r0.concepto_principal, 500),
    id_local: textoONull(r0.id_local, 20),
    relacionado_con: textoONull(r0.relacionado_con, 20),
    requiere_confirmacion: r0.requiere_confirmacion === true,
    confianza: typeof r0.confianza === 'number' ? Math.max(0, Math.min(1, r0.confianza)) : null,
    pregunta: textoONull(r0.pregunta, 300),
  };
  if (r0.fecha && !r.fecha) errores.push(`fecha inválida "${r0.fecha}" descartada`);
  if (r0.hora && !r.hora) errores.push(`hora inválida "${r0.hora}" descartada`);

  if (!categoria) {
    return { ...aRevision(r, `Categoría no reconocida: "${categoriaOriginal}"`, null, 'categoria'), errores };
  }
  if (!contenido) {
    return { ...aRevision(r, 'Registro sin contenido', '¿Qué querías guardar aquí?', 'aclaracion'), errores };
  }

  // Recordatorios relativos ("en dos horas"): el validador calcula la fecha exacta.
  const despl = Number(r0.desplazamiento_minutos);
  if (r.categoria === 'recordatorio' && Number.isFinite(despl) && despl > 0 && despl <= 60 * 24 * 60) {
    const t = sumarMinutos(ctx.hoy, ctx.hora, Math.round(despl));
    r.fecha = t.fecha;
    r.hora = t.hora;
  }

  // Reclasificación manual: el usuario ya decidió la categoría, no se vuelve a dudar de ella.
  if (!opciones.categoriaForzada) {
    if (r.requiere_confirmacion) {
      return { ...aRevision(r, 'El modelo pidió confirmación', r.pregunta, r.pregunta ? 'aclaracion' : 'categoria'), errores };
    }
    if (r.confianza !== null && r.confianza < UMBRAL_CONFIANZA) {
      return { ...aRevision(r, `Confianza baja (${r.confianza})`, null, 'categoria'), errores };
    }
  }

  switch (r.categoria) {
    case 'tarea':
      r.estado = normalizarEstadoTarea(r0.estado);
      break;
    case 'recordatorio':
      if (!r.fecha || !r.hora) {
        const falta = !r.fecha && !r.hora ? 'el día y la hora' : (!r.fecha ? 'el día' : 'la hora');
        return { ...aRevision(r, 'Recordatorio sin fecha u hora clara',
          `Para el recordatorio «${r.titulo}» me falta ${falta}. ¿Cuándo te aviso?`, 'aclaracion'), errores };
      }
      r.estado = 'programado';
      break;
    case 'evento':
      if (!r.fecha) {
        return { ...aRevision(r, 'Evento sin fecha',
          `¿Qué día es «${r.titulo}»? (y la hora, si la sabes)`, 'aclaracion'), errores };
      }
      if (r.hora_fin && (!r.hora || r.hora_fin <= r.hora)) r.hora_fin = null;
      r.estado = 'agendado';
      break;
    case 'idea':
      r.estado = normalizarEstadoIdea(r0.estado);
      r.prioridad = null;
      break;
    case 'conocimiento':
      r.prioridad = null;
      r.concepto_principal = r.concepto_principal || r.titulo;
      break;
    case 'otros':
      r.prioridad = null;
      break;
  }
  return { categoria_destino: r.categoria, registro: r, errores };
}

/* ---------- Validación de la salida completa ---------- */

function validarSalida(respuesta, ctx) {
  const leido = parsearJSON(respuesta);
  const original = ctx.texto_original || '';
  if (!leido.ok) {
    // Nunca se pierde la información: va a revisión con la transcripción completa.
    return {
      valido: false,
      errores: [leido.error],
      transcripcion_original: original,
      transcripcion_corregida: original,
      resumen_general: original.slice(0, 200),
      registros: [aRevision({ categoria: 'otros', titulo: original.slice(0, 80) || 'Mensaje', contenido: original, etiquetas: [] },
        'El clasificador no devolvió un JSON válido', null, 'categoria')],
      requiere_aclaracion: false,
      pregunta_aclaracion: null,
    };
  }
  const v = leido.valor || {};
  const errores = [];
  if (!Array.isArray(v.registros)) errores.push('Falta el arreglo "registros"');
  const brutos = Array.isArray(v.registros) ? v.registros.slice(0, 15) : [];
  const registros = [];
  brutos.forEach((b, i) => {
    const res = validarRegistro(b, ctx);
    if (!res.registro.id_local) res.registro.id_local = `r${i + 1}`;
    res.errores.forEach(e => errores.push(`registro ${i + 1}: ${e}`));
    registros.push({ categoria_destino: res.categoria_destino, registro: res.registro });
  });

  const requiereAclaracion = v.requiere_aclaracion === true;
  const pregunta = textoONull(v.pregunta_aclaracion, 300);

  if (registros.length === 0) {
    if (requiereAclaracion && pregunta) {
      registros.push(aRevision({ categoria: 'otros', titulo: original.slice(0, 80), contenido: original, etiquetas: [] },
        'El modelo necesita una aclaración', pregunta, 'aclaracion'));
    } else {
      // Regla: no descartar información que no se pudo clasificar.
      registros.push({
        categoria_destino: 'otros',
        registro: {
          categoria: 'otros', titulo: original.slice(0, 80) || 'Mensaje sin clasificar', contenido: textoONull(v.resumen_general) || original,
          fecha: null, hora: null, etiquetas: [], area_tematica: null, id_local: 'r1', requiere_confirmacion: false,
        },
      });
    }
  }

  return {
    valido: errores.length === 0,
    errores,
    transcripcion_original: original, // siempre la real, nunca la reescrita por el modelo
    transcripcion_corregida: textoONull(v.transcripcion_corregida, 20000) || original,
    resumen_general: textoONull(v.resumen_general, 1000) || original.slice(0, 200),
    registros,
    requiere_aclaracion: requiereAclaracion,
    pregunta_aclaracion: pregunta,
  };
}

/* Esquema que se pasa a Ollama en "format" para forzar la estructura. */
function esquemaSalida() {
  const txt = { type: ['string', 'null'] };
  return {
    type: 'object',
    properties: {
      transcripcion_original: { type: 'string' },
      transcripcion_corregida: { type: 'string' },
      resumen_general: { type: 'string' },
      registros: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id_local: { type: 'string' },
            categoria: { type: 'string', enum: CATEGORIAS },
            titulo: { type: 'string' },
            contenido: { type: 'string' },
            fecha: txt,
            hora: txt,
            hora_fin: txt,
            desplazamiento_minutos: { type: ['integer', 'null'] },
            prioridad: { type: ['string', 'null'], enum: ['alta', 'media', 'baja', null] },
            estado: txt,
            proyecto: txt,
            lugar: txt,
            participantes: { type: 'array', items: { type: 'string' } },
            fuente: txt,
            area_tematica: txt,
            concepto_principal: txt,
            aplicacion: txt,
            etiquetas: { type: 'array', items: { type: 'string' } },
            relacionado_con: txt,
            confianza: { type: 'number' },
            requiere_confirmacion: { type: 'boolean' },
            pregunta: txt,
          },
          required: ['id_local', 'categoria', 'titulo', 'contenido', 'fecha', 'hora', 'prioridad', 'estado',
            'proyecto', 'etiquetas', 'confianza', 'requiere_confirmacion'],
        },
      },
      requiere_aclaracion: { type: 'boolean' },
      pregunta_aclaracion: txt,
    },
    required: ['transcripcion_original', 'transcripcion_corregida', 'resumen_general', 'registros',
      'requiere_aclaracion', 'pregunta_aclaracion'],
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CATEGORIAS, validarSalida, validarRegistro, parsearJSON, normalizarCategoria, esquemaSalida,
    calendarioReferencia, ahoraEnZona, sumarDias, sumarMinutos, diaSemana, fechaValida, normalizarHora,
  };
}
