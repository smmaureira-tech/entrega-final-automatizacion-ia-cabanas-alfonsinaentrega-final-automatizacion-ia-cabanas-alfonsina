// Nodo "Clasificar entrada": decide qué llegó desde Telegram y si el remitente está autorizado.
const u = $input.first().json;
const msg = u.message || u.edited_message || null;
const cb = u.callback_query || null;
const chat = msg ? msg.chat.id : (cb ? cb.message.chat.id : null);
const permitido = String($env.TELEGRAM_CHAT_ID || '').trim();

const base = { chat_id: chat, tipo: 'ignorar', texto: '', file_id: null, reply_to: null, callback_id: null, callback_data: null };
if (!chat) return [{ json: base }];

// Sin chat configurado: se responde con el id para completar el .env (primer uso).
if (!permitido) return [{ json: { ...base, tipo: 'configurar' } }];
// Bot privado: a desconocidos no se les responde nada.
if (String(chat) !== permitido) return [{ json: base }];

if (cb) {
  return [{ json: { ...base, tipo: 'boton', callback_id: cb.id, callback_data: cb.data } }];
}
const audio = msg.voice || msg.audio || (msg.video_note ? msg.video_note : null);
if (audio) {
  return [{ json: { ...base, tipo: 'voz', file_id: audio.file_id } }];
}
const texto = String(msg.text || msg.caption || '').trim();
if (!texto) return [{ json: base }];
if (texto.startsWith('/')) return [{ json: { ...base, tipo: 'comando', texto } }];
return [{ json: { ...base, tipo: 'texto', texto, reply_to: msg.reply_to_message ? msg.reply_to_message.message_id : null } }];
