// Nodo "Preparar prompt": arma la llamada a Ollama con el calendario de referencia y el esquema JSON.
const zona = $env.GENERIC_TIMEZONE || 'America/Santiago';
const entrada = $input.first().json;
const ahora = ahoraEnZona(zona);
const ctx = { hoy: ahora.fecha, hora: ahora.hora, zona, texto_original: entrada.texto };
const usuario = [
  `HOY: ${diaSemana(ahora.fecha)} ${ahora.fecha}, hora actual ${ahora.hora} (${zona}).`,
  '',
  'CALENDARIO DE REFERENCIA:',
  calendarioReferencia(ahora.fecha),
  '',
  entrada.origen === 'voz' ? 'TRANSCRIPCIÓN DEL AUDIO:' : 'MENSAJE:',
  entrada.texto,
].join('\n');
const ollama_body = {
  model: $env.OLLAMA_MODEL || 'qwen2.5:7b',
  stream: false,
  format: esquemaSalida(),
  options: { temperature: 0.1, num_ctx: 8192 },
  keep_alive: '30m',
  messages: [
    { role: 'system', content: PROMPT_SISTEMA },
    { role: 'user', content: usuario },
  ],
};
return [{ json: { ...entrada, ctx, ollama_body } }];
