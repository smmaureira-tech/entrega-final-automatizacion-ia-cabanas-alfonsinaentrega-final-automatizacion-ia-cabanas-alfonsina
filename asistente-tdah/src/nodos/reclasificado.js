// Nodo "Registro reclasificado": la categoría la eligió la persona; se valida igual (fechas, horas)
// y se envía al mismo Switch de distribución.
const zona = $env.GENERIC_TIMEZONE || 'America/Santiago';
const a = $input.first().json;
const ahora = ahoraEnZona(zona);
const ctx = { hoy: ahora.fecha, hora: ahora.hora, zona, texto_original: a.redistribuir.registro.contenido || '' };
const res = validarRegistro(a.redistribuir.registro, ctx, { categoriaForzada: true });
return [{ json: {
  categoria_destino: res.categoria_destino,
  captura_id: a.redistribuir.captura_id,
  ejecucion_id: $execution.id,
  chat_id: a.chat_id,
  resumen: null,
  registro: Object.assign(res.registro, { id_local: null, relacionado_con: null }),
} }];
