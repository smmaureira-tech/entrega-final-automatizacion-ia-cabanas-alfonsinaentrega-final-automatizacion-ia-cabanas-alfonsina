// Nodo "Texto desde audio": toma la transcripción de Whisper.
const e = $('Clasificar entrada').first().json;
const t = String($input.first().json.text || '').trim();
return [{ json: { chat_id: e.chat_id, origen: 'voz', texto: t || '(audio vacío o inaudible)' } }];
