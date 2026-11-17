// Nodo "Preparar evento": fechas ISO para Google Calendar (con hora o de día completo).
const zona = $env.GENERIC_TIMEZONE || 'America/Santiago';
return $input.all().map(it => {
  const r = it.json.registro;
  let inicio, fin, todoElDia = 'no';
  if (r.hora) {
    inicio = `${r.fecha}T${r.hora}:00`;
    const f = r.hora_fin ? { fecha: r.fecha, hora: r.hora_fin } : sumarMinutos(r.fecha, r.hora, 60);
    fin = `${f.fecha}T${f.hora}:00`;
  } else {
    todoElDia = 'yes';
    inicio = r.fecha;
    fin = sumarDias(r.fecha, 1);
  }
  const partes = [r.contenido];
  if (r.participantes && r.participantes.length) partes.push('Participantes: ' + r.participantes.join(', '));
  partes.push(`Creado por el asistente desde Telegram (${it.json.ejecucion_id}).`);
  return { json: { ...it.json, gcal: { inicio, fin, todoElDia, zona, titulo: r.titulo, descripcion: partes.join('\n\n'), lugar: r.lugar || '' } } };
});
