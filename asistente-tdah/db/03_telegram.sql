-- =====================================================================
-- Consultas y acciones desde Telegram (comandos y botones),
-- cola de recordatorios y resúmenes diarios/semanales.
-- Todas devuelven jsonb: { texto, teclado?, redistribuir?, eliminar_evento_google? }
-- =====================================================================

-- "Lo que quedó en el tintero": todo lo que se pasó y no se cerró.
CREATE OR REPLACE FUNCTION tintero()
RETURNS TABLE (codigo text, tipo text, titulo text, fecha date, motivo text, dias int)
LANGUAGE sql STABLE AS $$
  SELECT 'T' || id AS codigo, 'tarea' AS tipo, titulo, fecha_limite AS fecha, 'vencida' AS motivo, hoy() - fecha_limite AS dias
    FROM tareas WHERE estado <> 'completada' AND fecha_limite < hoy()
  UNION ALL
  SELECT 'T' || id, 'tarea', titulo, NULL::date, 'sin fecha hace ' || (hoy() - (fecha_captura AT TIME ZONE zona())::date) || ' días',
         hoy() - (fecha_captura AT TIME ZONE zona())::date
    FROM tareas WHERE estado <> 'completada' AND fecha_limite IS NULL AND fecha_captura < now() - interval '7 days'
  UNION ALL
  SELECT 'R' || id, 'recordatorio', mensaje, fecha, 'avisado y sin confirmar', hoy() - fecha
    FROM recordatorios WHERE estado = 'enviado' AND enviado_en < now() - interval '1 hour'
  UNION ALL
  SELECT 'E' || id, 'evento', nombre, fecha, '¿se realizó?', hoy() - fecha
    FROM eventos WHERE estado = 'agendado' AND fecha < hoy()
  UNION ALL
  SELECT 'V' || id, 'revision', titulo, creado_en::date, 'esperando clasificación', hoy() - (creado_en AT TIME ZONE zona())::date
    FROM revision WHERE estado = 'pendiente'
  ORDER BY dias DESC NULLS LAST
$$;

CREATE OR REPLACE FUNCTION botones_para(cod text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE left(cod, 1)
    WHEN 'T' THEN jsonb_build_array(
      jsonb_build_object('text', '✅ ' || cod, 'callback_data', 'ok:' || cod),
      jsonb_build_object('text', '📅 Mañana', 'callback_data', 'man:' || cod),
      jsonb_build_object('text', '➡️ Lunes', 'callback_data', 'lun:' || cod))
    WHEN 'R' THEN jsonb_build_array(
      jsonb_build_object('text', '✅ ' || cod, 'callback_data', 'ok:' || cod),
      jsonb_build_object('text', '⏰ +1 h', 'callback_data', 'snz:' || cod || ':60'),
      jsonb_build_object('text', '📅 Mañana', 'callback_data', 'man:' || cod))
    WHEN 'E' THEN jsonb_build_array(
      jsonb_build_object('text', '✅ Se hizo ' || cod, 'callback_data', 'ok:' || cod),
      jsonb_build_object('text', '❌ No se hizo', 'callback_data', 'no:' || cod))
    ELSE '[]'::jsonb END
$$;

CREATE OR REPLACE FUNCTION linea_tarea(t tareas) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT format(E'%s <b>T%s</b> %s%s%s%s',
    CASE WHEN t.estado = 'en curso' THEN '🔄' WHEN t.fecha_limite < hoy() THEN '🔴'
         WHEN t.fecha_limite = hoy() THEN '🟠' ELSE '⬜' END,
    t.id, esc(t.titulo),
    CASE WHEN t.fecha_limite IS NOT NULL THEN ' · ' || dia_corto(t.fecha_limite) ELSE '' END,
    CASE WHEN t.prioridad = 'alta' THEN ' · ‼️' ELSE '' END,
    CASE WHEN t.proyecto IS NOT NULL THEN ' · ' || esc(t.proyecto) ELSE '' END)
$$;

-- Reconstruye un registro con la forma del clasificador (para reclasificar).
CREATE OR REPLACE FUNCTION registro_generico(cod text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE pre text := left(cod, 1); n int := substr(cod, 2)::int; r jsonb;
BEGIN
  CASE pre
    WHEN 'T' THEN SELECT jsonb_build_object('titulo', titulo, 'contenido', coalesce(descripcion, titulo), 'fecha', fecha_limite,
                         'prioridad', prioridad, 'proyecto', proyecto, 'etiquetas', to_jsonb(etiquetas), '_captura', captura_id)
                  INTO r FROM tareas WHERE id = n;
    WHEN 'R' THEN SELECT jsonb_build_object('titulo', left(mensaje, 80), 'contenido', mensaje, 'fecha', fecha,
                         'hora', hhmm(hora), 'etiquetas', '[]'::jsonb, '_captura', captura_id)
                  INTO r FROM recordatorios WHERE id = n;
    WHEN 'E' THEN SELECT jsonb_build_object('titulo', nombre, 'contenido', coalesce(descripcion, nombre), 'fecha', fecha,
                         'hora', hhmm(hora_inicio), 'hora_fin', hhmm(hora_termino), 'lugar', lugar,
                         'participantes', to_jsonb(participantes), 'etiquetas', to_jsonb(etiquetas),
                         '_captura', captura_id, '_google', google_event_id)
                  INTO r FROM eventos WHERE id = n;
    WHEN 'I' THEN SELECT jsonb_build_object('titulo', titulo, 'contenido', descripcion, 'area_tematica', area_tematica,
                         'proyecto', proyecto, 'aplicacion', potencial_aplicacion, 'etiquetas', to_jsonb(etiquetas),
                         '_captura', captura_id)
                  INTO r FROM ideas WHERE id = n;
    WHEN 'C' THEN SELECT jsonb_build_object('titulo', titulo, 'contenido', explicacion, 'concepto_principal', concepto_principal,
                         'fuente', fuente, 'area_tematica', area_tematica, 'aplicacion', aplicaciones,
                         'etiquetas', to_jsonb(etiquetas), '_captura', captura_id)
                  INTO r FROM conocimientos WHERE id = n;
    WHEN 'O' THEN SELECT jsonb_build_object('titulo', titulo, 'contenido', coalesce(resumen, transcripcion), 'area_tematica', tema,
                         'etiquetas', to_jsonb(etiquetas), '_captura', captura_id)
                  INTO r FROM otros WHERE id = n;
    WHEN 'V' THEN SELECT registro || jsonb_build_object('_captura', captura_id) INTO r
                  FROM revision WHERE id = n AND estado = 'pendiente';
    ELSE r := NULL;
  END CASE;
  RETURN r;
END $$;

-- Mueve un registro a otra categoría. El registro se vuelve a validar y distribuir en n8n
-- (así un evento movido se crea en Google Calendar y un recordatorio sin hora pide aclaración).
CREATE OR REPLACE FUNCTION reclasificar(cod text, p_destino text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE pre text := left(cod, 1); n int := substr(cod, 2)::int; r jsonb; g text; destino text;
BEGIN
  destino := lower(translate(btrim(coalesce(p_destino, '')), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou'));
  destino := CASE destino WHEN 'tareas' THEN 'tarea' WHEN 'recordatorios' THEN 'recordatorio' WHEN 'eventos' THEN 'evento'
                          WHEN 'ideas' THEN 'idea' WHEN 'conocimientos' THEN 'conocimiento' WHEN 'otro' THEN 'otros'
                          ELSE destino END;
  IF destino NOT IN ('tarea', 'recordatorio', 'evento', 'idea', 'conocimiento', 'otros') THEN
    RETURN jsonb_build_object('texto', 'Categorías válidas: tarea, recordatorio, evento, idea, conocimiento, otros.');
  END IF;
  r := registro_generico(cod);
  IF r IS NULL THEN
    RETURN jsonb_build_object('texto', format('No encontré %s (o ya fue resuelto).', esc(cod)));
  END IF;
  g := r ->> '_google';
  INSERT INTO reclasificaciones (codigo_anterior, categoria_destino, datos) VALUES (cod, destino, r);
  CASE pre
    WHEN 'T' THEN DELETE FROM tareas WHERE id = n;
    WHEN 'R' THEN DELETE FROM recordatorios WHERE id = n;
    WHEN 'E' THEN DELETE FROM eventos WHERE id = n;
    WHEN 'I' THEN DELETE FROM ideas WHERE id = n;
    WHEN 'C' THEN DELETE FROM conocimientos WHERE id = n;
    WHEN 'O' THEN DELETE FROM otros WHERE id = n;
    WHEN 'V' THEN UPDATE revision SET estado = 'resuelta', resuelto_en = now() WHERE id = n;
  END CASE;
  DELETE FROM vinculos v WHERE v.origen = cod OR v.destino = cod;
  RETURN jsonb_build_object(
    'texto', format('🔀 Moviendo <b>%s</b> a <b>%s</b>…', esc(cod), destino),
    'redistribuir', jsonb_build_object('captura_id', (r ->> '_captura')::int,
                                       'registro', (r - '_captura' - '_google') || jsonb_build_object('categoria', destino)),
    'eliminar_evento_google', g);
END $$;

-- Cambia el estado de un registro: hecho / en curso / pendiente / no realizado / cancelar.
CREATE OR REPLACE FUNCTION cambiar_estado(cod text, accion text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE pre text := left(cod, 1); n int; filas int := 0; g text; t text;
BEGIN
  IF cod !~ '^[TREICOV]\d+$' THEN
    RETURN jsonb_build_object('texto', 'Usa un código como T12, R3 o E5.');
  END IF;
  n := substr(cod, 2)::int;
  IF pre = 'T' AND accion IN ('hecho', 'encurso', 'pendiente') THEN
    UPDATE tareas SET estado = CASE accion WHEN 'hecho' THEN 'completada' WHEN 'encurso' THEN 'en curso' ELSE 'pendiente' END,
                      completada_en = CASE WHEN accion = 'hecho' THEN now() END, actualizado_en = now()
    WHERE id = n RETURNING titulo INTO t;
    GET DIAGNOSTICS filas = ROW_COUNT;
    IF filas > 0 THEN
      RETURN jsonb_build_object('texto', CASE accion WHEN 'hecho' THEN format('🎉 <b>%s</b> completada: %s. ¡Bien!', cod, esc(t))
                                                     WHEN 'encurso' THEN format('🔄 <b>%s</b> en curso: %s', cod, esc(t))
                                                     ELSE format('⬜ <b>%s</b> vuelve a pendiente: %s', cod, esc(t)) END);
    END IF;
  ELSIF pre = 'R' AND accion IN ('hecho', 'cancelar') THEN
    UPDATE recordatorios SET estado = CASE accion WHEN 'hecho' THEN 'confirmado' ELSE 'cancelado' END,
                             confirmado_en = CASE WHEN accion = 'hecho' THEN now() END
    WHERE id = n RETURNING mensaje INTO t;
    GET DIAGNOSTICS filas = ROW_COUNT;
    IF filas > 0 THEN
      RETURN jsonb_build_object('texto', CASE accion WHEN 'hecho' THEN format('✅ <b>%s</b> confirmado: %s', cod, esc(t))
                                                     ELSE format('🚫 <b>%s</b> cancelado: %s', cod, esc(t)) END);
    END IF;
  ELSIF pre = 'E' AND accion IN ('hecho', 'no', 'cancelar') THEN
    UPDATE eventos SET estado = CASE accion WHEN 'hecho' THEN 'realizado' WHEN 'no' THEN 'no realizado' ELSE 'cancelado' END
    WHERE id = n RETURNING nombre, google_event_id INTO t, g;
    GET DIAGNOSTICS filas = ROW_COUNT;
    IF filas > 0 THEN
      RETURN jsonb_build_object(
        'texto', CASE accion WHEN 'hecho' THEN format('✅ <b>%s</b> realizado: %s', cod, esc(t))
                             WHEN 'no' THEN format(E'📝 <b>%s</b> marcado como no realizado: %s\nSi hay que reagendarlo, mándame un audio con la nueva fecha.', cod, esc(t))
                             ELSE format('🚫 <b>%s</b> cancelado y quitado de Google Calendar: %s', cod, esc(t)) END,
        'eliminar_evento_google', CASE WHEN accion = 'cancelar' THEN g END);
    END IF;
  ELSE
    RETURN jsonb_build_object('texto', format('Esa acción no aplica a %s.', esc(cod)));
  END IF;
  RETURN jsonb_build_object('texto', format('No encontré %s.', esc(cod)));
END $$;

-- Reprograma una tarea (nueva fecha límite) o un recordatorio (nueva fecha/hora o +N minutos).
CREATE OR REPLACE FUNCTION reprogramar(cod text, cuando text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  pre text := left(cod, 1); n int; d date; h time; m text[]; partes text[]; filas int; t text;
  ts timestamp;
BEGIN
  IF cod !~ '^[TR]\d+$' THEN
    RETURN jsonb_build_object('texto', E'Se pueden reprogramar tareas (T) y recordatorios (R).\nLos eventos se mueven en Google Calendar o con un audio nuevo.');
  END IF;
  n := substr(cod, 2)::int;
  cuando := lower(btrim(coalesce(cuando, '')));
  m := regexp_match(cuando, '^\+(\d+)\s*(m|min|h)$');
  IF m IS NOT NULL AND pre = 'R' THEN
    ts := ahora_local() + (m[1] || CASE WHEN m[2] = 'h' THEN ' hours' ELSE ' minutes' END)::interval;
    d := ts::date; h := ts::time;
  ELSE
    -- separa una hora final opcional: "mañana 10:30", "viernes 9"
    m := regexp_match(cuando, '^(.*?)\s+(\d{1,2})(?::(\d{2}))?\s*(?:h|hrs)?$');
    IF m IS NOT NULL AND interpretar_fecha(m[1]) IS NOT NULL THEN
      d := interpretar_fecha(m[1]);
      h := make_time(m[2]::int, coalesce(m[3], '0')::int, 0);
    ELSE
      d := interpretar_fecha(cuando);
    END IF;
  END IF;
  IF d IS NULL THEN
    RETURN jsonb_build_object('texto', 'No entendí la fecha. Ejemplos: mañana · viernes · 25/11 · +3 · lunes 10:30 · +30m');
  END IF;
  IF pre = 'T' THEN
    UPDATE tareas SET fecha_limite = d, reprogramaciones = reprogramaciones + 1, actualizado_en = now(),
                      estado = CASE WHEN estado = 'completada' THEN 'pendiente' ELSE estado END, completada_en = NULL
    WHERE id = n RETURNING titulo INTO t;
    GET DIAGNOSTICS filas = ROW_COUNT;
    IF filas = 0 THEN RETURN jsonb_build_object('texto', format('No encontré %s.', cod)); END IF;
    RETURN jsonb_build_object('texto', format('📅 <b>%s</b> %s → ahora vence el <b>%s</b>', cod, esc(t), dia_corto(d)));
  ELSE
    UPDATE recordatorios SET fecha = d, hora = coalesce(h, hora),
                             programado_para = (d + coalesce(h, hora)) AT TIME ZONE zona(),
                             estado = 'programado', insistencias = 0, enviado_en = NULL
    WHERE id = n RETURNING mensaje, hora INTO t, h;
    GET DIAGNOSTICS filas = ROW_COUNT;
    IF filas = 0 THEN RETURN jsonb_build_object('texto', format('No encontré %s.', cod)); END IF;
    RETURN jsonb_build_object('texto', format('⏰ <b>%s</b> %s → te aviso el <b>%s a las %s</b>', cod, esc(t), dia_corto(d), hhmm(h)));
  END IF;
END $$;

-- Detalle completo de un registro (/ver T12).
CREATE OR REPLACE FUNCTION ver_registro(cod text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE pre text := left(cod, 1); n int; s text; cap int; rel text;
BEGIN
  IF cod !~ '^[TREICOV]\d+$' THEN RETURN jsonb_build_object('texto', 'Uso: /ver T12'); END IF;
  n := substr(cod, 2)::int;
  CASE pre
    WHEN 'T' THEN SELECT format(E'✅ <b>T%s · %s</b>\n%s\n\nEstado: %s\nVence: %s\nPrioridad: %s\nProyecto: %s\nEtiquetas: %s\nCapturada: %s\nVeces reprogramada: %s',
                         id, esc(titulo), esc(descripcion), estado, coalesce(dia_corto(fecha_limite), '—'), coalesce(prioridad, '—'),
                         esc(coalesce(proyecto, '—')), coalesce(nullif(array_to_string(etiquetas, ', '), ''), '—'),
                         to_char(fecha_captura AT TIME ZONE zona(), 'DD/MM/YYYY HH24:MI'), reprogramaciones), captura_id
                  INTO s, cap FROM tareas WHERE id = n;
    WHEN 'R' THEN SELECT format(E'⏰ <b>R%s</b>\n%s\n\nCuándo: %s %s\nEstado: %s\nCreado: %s\nConfirmado: %s',
                         id, esc(mensaje), dia_corto(fecha), hhmm(hora), estado,
                         to_char(creado_en AT TIME ZONE zona(), 'DD/MM HH24:MI'),
                         coalesce(to_char(confirmado_en AT TIME ZONE zona(), 'DD/MM HH24:MI'), '—')), captura_id
                  INTO s, cap FROM recordatorios WHERE id = n;
    WHEN 'E' THEN SELECT format(E'📅 <b>E%s · %s</b>\n%s\n\nCuándo: %s %s%s\nLugar: %s\nParticipantes: %s\nEstado: %s\n%s',
                         id, esc(nombre), esc(coalesce(descripcion, '')), dia_corto(fecha), coalesce(hhmm(hora_inicio), 'todo el día'),
                         coalesce('–' || hhmm(hora_termino), ''), esc(coalesce(lugar, '—')),
                         esc(coalesce(nullif(array_to_string(participantes, ', '), ''), '—')), estado,
                         CASE WHEN google_link IS NOT NULL THEN '<a href="' || google_link || '">Abrir en Google Calendar</a>'
                              ELSE '⚠️ No está en Google Calendar: ' || esc(coalesce(calendar_error, 'sin detalle')) END), captura_id
                  INTO s, cap FROM eventos WHERE id = n;
    WHEN 'I' THEN SELECT format(E'💡 <b>I%s · %s</b>\n%s\n\nEstado: %s\nÁrea: %s\nProyecto: %s\nAplicación: %s\nEtiquetas: %s\nCapturada: %s',
                         id, esc(titulo), esc(descripcion), estado, esc(coalesce(area_tematica, '—')), esc(coalesce(proyecto, '—')),
                         esc(coalesce(potencial_aplicacion, '—')), coalesce(nullif(array_to_string(etiquetas, ', '), ''), '—'),
                         to_char(fecha_captura AT TIME ZONE zona(), 'DD/MM/YYYY')), captura_id
                  INTO s, cap FROM ideas WHERE id = n;
    WHEN 'C' THEN SELECT format(E'📚 <b>C%s · %s</b>\n<b>Concepto:</b> %s\n\n%s\n\nFuente: %s\nÁrea: %s\nAplicaciones: %s\nEtiquetas: %s',
                         id, esc(titulo), esc(coalesce(concepto_principal, '—')), esc(explicacion), esc(coalesce(fuente, '—')),
                         esc(coalesce(area_tematica, '—')), esc(coalesce(aplicaciones, '—')),
                         coalesce(nullif(array_to_string(etiquetas, ', '), ''), '—')), captura_id
                  INTO s, cap FROM conocimientos WHERE id = n;
    WHEN 'O' THEN SELECT format(E'📦 <b>O%s · %s</b>\n%s\n\nTema: %s\n<i>Transcripción:</i> %s',
                         id, esc(titulo), esc(coalesce(resumen, '')), esc(coalesce(tema, '—')), esc(left(coalesce(transcripcion, ''), 2500))), captura_id
                  INTO s, cap FROM otros WHERE id = n;
    WHEN 'V' THEN SELECT format(E'🤔 <b>V%s · %s</b>\n%s\n\nMotivo: %s\nPregunta: %s\nEstado: %s',
                         id, esc(titulo), esc(registro ->> 'contenido'), esc(coalesce(motivo, '—')), esc(coalesce(pregunta, '—')), estado), captura_id
                  INTO s, cap FROM revision WHERE id = n;
  END CASE;
  IF s IS NULL THEN RETURN jsonb_build_object('texto', format('No encontré %s.', cod)); END IF;
  SELECT string_agg(codigo || ' ' || esc(titulo), ', ') INTO rel
    FROM v_registros WHERE captura_id = cap AND codigo <> cod;
  IF rel IS NOT NULL THEN s := s || E'\n\n🔗 Del mismo audio: ' || rel; END IF;
  RETURN jsonb_build_object('texto', s,
    'teclado', CASE WHEN jsonb_array_length(botones_para(cod)) > 0
                    THEN jsonb_build_object('inline_keyboard', jsonb_build_array(botones_para(cod))) END);
END $$;

-- Listados por categoría (cada categoría se consulta por separado).
CREATE OR REPLACE FUNCTION listar(cat text, filtro text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s text; tec jsonb := '[]'::jsonb; x record; tt tareas; q tsquery;
BEGIN
  filtro := nullif(btrim(coalesce(filtro, '')), '');
  CASE cat
    WHEN 'tareas' THEN
      FOR tt IN SELECT * FROM tareas
               WHERE (filtro = 'todas' OR estado <> 'completada')
                 AND (filtro IS NULL OR filtro = 'todas' OR proyecto ILIKE '%' || filtro || '%' OR filtro = ANY (etiquetas))
               ORDER BY (estado = 'completada'), fecha_limite NULLS LAST, (prioridad = 'alta') DESC, id LIMIT 30 LOOP
        s := coalesce(s || E'\n', '') || linea_tarea(tt);
        IF jsonb_array_length(tec) < 6 AND tt.estado <> 'completada' THEN tec := tec || jsonb_build_array(botones_para('T' || tt.id)); END IF;
      END LOOP;
      s := E'✅ <b>Tareas pendientes</b>\n' || coalesce(s, 'No tienes tareas pendientes 🎉')
           || E'\n\n<i>/hecho T1 · /encurso T1 · /reprogramar T1 viernes · /tareas todas</i>';
    WHEN 'recordatorios' THEN
      SELECT string_agg(format('⏰ <b>R%s</b> %s %s · %s%s', id, dia_corto(fecha), hhmm(hora), esc(mensaje),
                               CASE WHEN estado = 'enviado' THEN ' · <i>sin confirmar</i>' ELSE '' END), E'\n' ORDER BY programado_para)
        INTO s FROM recordatorios WHERE estado IN ('programado', 'enviado', 'enviando');
      s := E'⏰ <b>Recordatorios activos</b>\n' || coalesce(s, 'No hay recordatorios programados.')
           || E'\n\n<i>/reprogramar R1 mañana 9 · /hecho R1 · /cancelar R1</i>';
    WHEN 'eventos' THEN
      SELECT string_agg(format('📅 <b>E%s</b> %s %s · %s%s', id, dia_corto(fecha), coalesce(hhmm(hora_inicio), 'todo el día'),
                               esc(nombre), coalesce(' · ' || esc(lugar), '')), E'\n' ORDER BY fecha, hora_inicio NULLS FIRST)
        INTO s FROM eventos WHERE estado = 'agendado' AND fecha BETWEEN hoy() AND hoy() + 30;
      s := E'📅 <b>Próximos eventos (30 días)</b>\n' || coalesce(s, 'No hay eventos agendados.');
    WHEN 'ideas' THEN
      SELECT string_agg(format('💡 <b>I%s</b> %s · <i>%s</i>%s', id, esc(titulo), estado, coalesce(' · ' || esc(proyecto), '')),
                        E'\n' ORDER BY fecha_captura DESC)
        INTO s FROM (SELECT * FROM ideas
                     WHERE (filtro IS NULL AND estado <> 'descartada') OR estado ILIKE filtro || '%'
                        OR proyecto ILIKE '%' || filtro || '%' OR area_tematica ILIKE '%' || filtro || '%'
                     ORDER BY fecha_captura DESC LIMIT 25) z;
      s := E'💡 <b>Biblioteca de ideas</b>\n' || coalesce(s, 'Sin ideas todavía.')
           || E'\n\n<i>/ver I1 · /idea I1 exploracion|desarrollo|descartada</i>';
    WHEN 'conocimientos' THEN
      IF filtro IS NOT NULL THEN q := websearch_to_tsquery('spanish', filtro); END IF;
      SELECT string_agg(format('📚 <b>C%s</b> %s%s', id, esc(titulo), coalesce(' · ' || esc(area_tematica), '')), E'\n')
        INTO s FROM (SELECT * FROM conocimientos
                     WHERE q IS NULL OR busqueda @@ q OR area_tematica ILIKE '%' || filtro || '%' OR filtro = ANY (etiquetas)
                     ORDER BY CASE WHEN q IS NULL THEN 0 ELSE -ts_rank(busqueda, q) END, fecha_captura DESC LIMIT 25) z;
      s := E'📚 <b>Biblioteca de conocimientos</b>' || coalesce(' · búsqueda: ' || esc(filtro), '') || E'\n'
           || coalesce(s, 'Nada por aquí.') || E'\n\n<i>/ver C1 · /conocimientos webhooks</i>';
    WHEN 'otros' THEN
      SELECT string_agg(format('📦 <b>O%s</b> %s · %s', id, esc(titulo), to_char(fecha AT TIME ZONE zona(), 'DD/MM')), E'\n' ORDER BY fecha DESC)
        INTO s FROM (SELECT * FROM otros ORDER BY fecha DESC LIMIT 25) z;
      s := E'📦 <b>Archivo general</b>\n' || coalesce(s, 'Vacío.');
    WHEN 'revision' THEN
      FOR x IN SELECT * FROM revision WHERE estado = 'pendiente' ORDER BY creado_en LIMIT 10 LOOP
        s := coalesce(s || E'\n', '') || format('🤔 <b>V%s</b> %s · <i>%s</i>', x.id, esc(x.titulo), esc(x.motivo));
      END LOOP;
      s := E'🤔 <b>En revisión</b>\n' || coalesce(s, 'Nada pendiente de revisar 👌')
           || E'\n\n<i>/mover V1 tarea · o responde a la pregunta original</i>';
  END CASE;
  RETURN jsonb_build_object('texto', s,
    'teclado', CASE WHEN jsonb_array_length(tec) > 0 THEN jsonb_build_object('inline_keyboard', tec) END);
END $$;

-- Búsqueda en todas las categorías.
CREATE OR REPLACE FUNCTION buscar(q text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('texto',
    '🔎 <b>Resultados para «' || esc(q) || E'»</b>\n' ||
    coalesce((SELECT string_agg(format('<b>%s</b> %s · <i>%s</i>', codigo, esc(titulo), categoria), E'\n')
              FROM (SELECT * FROM v_registros
                    WHERE titulo ILIKE '%' || q || '%' OR texto ILIKE '%' || q || '%'
                    ORDER BY creado_en DESC LIMIT 20) z), 'Sin resultados.'))
$$;
