// Nodo "Resultado de la acción": normaliza lo que devolvió la base para comandos y botones.
const e = $('Clasificar entrada').first().json;
const r = $input.first().json.r || {};
return [{ json: {
  chat_id: e.chat_id,
  texto: r.texto || 'Listo.',
  teclado: r.teclado || null,
  redistribuir: r.redistribuir || null,
  eliminar_evento_google: r.eliminar_evento_google || null,
} }];
