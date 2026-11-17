// Nodo "Expandir registros": un ítem por registro, todos ligados a la misma captura.
const v = $('Validar JSON').first().json;
const captura_id = $input.first().json.captura_id;
return v.registros.map(r => ({ json: {
  categoria_destino: r.categoria_destino,
  captura_id,
  ejecucion_id: $execution.id,
  chat_id: v.chat_id,
  resumen: v.resumen_general,
  registro: r.registro,
} }));
