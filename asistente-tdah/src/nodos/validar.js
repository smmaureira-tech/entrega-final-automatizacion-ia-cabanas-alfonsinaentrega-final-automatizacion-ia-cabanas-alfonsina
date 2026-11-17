// Nodo "Validar JSON": nada se distribuye sin pasar por aquí.
const prep = $('Preparar prompt').first().json;
const resp = $input.first().json;
const contenido = resp.message ? resp.message.content : (resp.response || resp);
const v = validarSalida(contenido, prep.ctx);
return [{ json: {
  chat_id: prep.chat_id,
  ...v,
  captura: {
    ejecucion_id: $execution.id,
    origen: prep.origen,
    transcripcion_original: v.transcripcion_original,
    transcripcion_corregida: v.transcripcion_corregida,
    resumen_general: v.resumen_general,
    json_clasificador: parsearJSON(contenido).valor || { bruto: String(contenido).slice(0, 5000) },
    errores: v.errores,
  },
} }];
