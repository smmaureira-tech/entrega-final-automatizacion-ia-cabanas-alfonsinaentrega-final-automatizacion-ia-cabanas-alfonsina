// Nodo "Texto desde mensaje": si respondía a una pregunta de revisión, el texto ya viene combinado.
const e = $('Clasificar entrada').first().json;
const r = $input.first().json.r || {};
return [{ json: { chat_id: e.chat_id, origen: r.origen || 'texto', texto: r.texto || e.texto, revision: r.revision || null } }];
