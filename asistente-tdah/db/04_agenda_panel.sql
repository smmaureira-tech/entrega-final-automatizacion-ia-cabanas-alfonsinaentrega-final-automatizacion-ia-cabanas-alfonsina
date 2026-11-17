-- =====================================================================
-- Agenda del día, resúmenes automáticos, cola de recordatorios,
-- enrutador de comandos/botones y datos del panel semanal.
-- =====================================================================

CREATE OR REPLACE FUNCTION agenda_dia(d date) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE s text := ''; parte text;
BEGIN
  SELECT string_agg(format('📅 %s <b>E%s</b> %s%s', coalesce(hhmm(hora_inicio), 'todo el día'), id, esc(nombre),
                           coalesce(' · ' || esc(lugar), '')), E'\n' ORDER BY hora_inicio NULLS FIRST)
    INTO parte FROM eventos WHERE fecha = d AND estado <> 'cancelado';
  IF parte IS NOT NULL THEN s := s || parte || E'\n'; END IF;
  SELECT string_agg(format('⏰ %s <b>R%s</b> %s', hhmm(hora), id, esc(mensaje)), E'\n' ORDER BY hora)
    INTO parte FROM recordatorios WHERE fecha = d AND estado IN ('programado', 'enviado', 'enviando');
  IF parte IS NOT NULL THEN s := s || parte || E'\n'; END IF;
  SELECT string_agg(linea_tarea(t), E'\n' ORDER BY (t.prioridad = 'alta') DESC, t.id)
    INTO parte FROM tareas t WHERE t.fecha_limite = d AND t.estado <> 'completada';
  IF parte IS NOT NULL THEN s := s || parte || E'\n'; END IF;
  RETURN nullif(s, '');
END $$;

-- Mensaje de la mañana: el día de hoy + lo atrasado, con botones para resolver.
CREATE OR REPLACE FUNCTION resumen_diario() RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s text; atrasadas text; tec jsonb := '[]'::jsonb; x record; nrev int; sinfecha int;
BEGIN
  s := format(E'☀️ <b>Buen día. Hoy es %s %s</b>\n\n', dia_largo(hoy()), to_char(hoy(), 'DD/MM'));
  s := s || coalesce(agenda_dia(hoy()), E'Nada agendado para hoy. Buen día para avanzar una tarea pendiente.\n');
  FOR x IN SELECT * FROM tintero() WHERE tipo IN ('tarea', 'evento') ORDER BY dias DESC LIMIT 6 LOOP
    atrasadas := coalesce(atrasadas || E'\n', '') || format('• <b>%s</b> %s <i>(%s)</i>', x.codigo, esc(x.titulo), x.motivo);
    tec := tec || jsonb_build_array(botones_para(x.codigo));
  END LOOP;
  IF atrasadas IS NOT NULL THEN
    s := s || E'\n🫙 <b>Quedó en el tintero</b>\n' || atrasadas || E'\n';
  END IF;
  SELECT count(*) INTO nrev FROM revision WHERE estado = 'pendiente';
  IF nrev > 0 THEN s := s || format(E'\n🤔 %s en revisión → /revision\n', nrev); END IF;
  SELECT count(*) INTO sinfecha FROM tareas WHERE estado <> 'completada' AND fecha_limite IS NULL;
  IF sinfecha > 0 THEN s := s || format(E'⬜ %s tareas sin fecha → /tareas\n', sinfecha); END IF;
  s := s || E'\n<i>Una cosa a la vez. Elige la primera y dale.</i>';
  RETURN jsonb_build_object('texto', s,
    'teclado', CASE WHEN jsonb_array_length(tec) > 0 THEN jsonb_build_object('inline_keyboard', tec) END);
END $$;

-- Mensaje de la noche: cerrar lo de hoy para que nada quede flotando.
CREATE OR REPLACE FUNCTION resumen_noche() RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s text; tec jsonb := '[]'::jsonb; x record; hechas int; manana text;
BEGIN
  SELECT count(*) INTO hechas FROM tareas WHERE (completada_en AT TIME ZONE zona())::date = hoy();
  s := format(E'🌙 <b>Cierre del día</b>\nCompletaste <b>%s</b> %s hoy.\n', hechas, CASE WHEN hechas = 1 THEN 'tarea' ELSE 'tareas' END);
  FOR x IN SELECT 'T' || id AS cod, titulo AS t FROM tareas WHERE fecha_limite = hoy() AND estado <> 'completada'
           UNION ALL SELECT 'E' || id, nombre FROM eventos WHERE fecha = hoy() AND estado = 'agendado' LIMIT 8 LOOP
    IF jsonb_array_length(tec) = 0 THEN s := s || E'\n¿Qué pasó con esto?\n'; END IF;
    s := s || format(E'• <b>%s</b> %s\n', x.cod, esc(x.t));
    tec := tec || jsonb_build_array(botones_para(x.cod));
  END LOOP;
  manana := agenda_dia(hoy() + 1);
  IF manana IS NOT NULL THEN s := s || E'\n🗓 <b>Mañana</b>\n' || manana; END IF;
  RETURN jsonb_build_object('texto', s,
    'teclado', CASE WHEN jsonb_array_length(tec) > 0 THEN jsonb_build_object('inline_keyboard', tec) END);
END $$;

-- Métricas de una semana (lunes a domingo). p_offset = 0 semana actual, -1 la anterior…
CREATE OR REPLACE FUNCTION metricas_semana(p_offset int DEFAULT 0) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH s AS (SELECT (date_trunc('week', hoy()) + make_interval(weeks => p_offset))::date AS ini),
  r AS (SELECT ini, ini + 6 AS fin FROM s)
  SELECT jsonb_build_object(
    'inicio', r.ini, 'fin', r.fin,
    'tareas_completadas', (SELECT count(*) FROM tareas WHERE (completada_en AT TIME ZONE zona())::date BETWEEN r.ini AND r.fin),
    'tareas_creadas', (SELECT count(*) FROM tareas WHERE (fecha_captura AT TIME ZONE zona())::date BETWEEN r.ini AND r.fin),
    'tareas_con_plazo', (SELECT count(*) FROM tareas WHERE fecha_limite BETWEEN r.ini AND least(r.fin, hoy())),
    'tareas_a_tiempo', (SELECT count(*) FROM tareas WHERE fecha_limite BETWEEN r.ini AND least(r.fin, hoy())
                          AND estado = 'completada' AND (completada_en AT TIME ZONE zona())::date <= fecha_limite),
    'reprogramaciones', (SELECT coalesce(sum(reprogramaciones), 0) FROM tareas WHERE fecha_limite BETWEEN r.ini AND r.fin),
    'recordatorios_enviados', (SELECT count(*) FROM recordatorios WHERE fecha BETWEEN r.ini AND r.fin AND estado IN ('enviado', 'confirmado')),
    'recordatorios_confirmados', (SELECT count(*) FROM recordatorios WHERE fecha BETWEEN r.ini AND r.fin AND estado = 'confirmado'),
    'eventos', (SELECT count(*) FROM eventos WHERE fecha BETWEEN r.ini AND r.fin AND estado <> 'cancelado'),
    'eventos_realizados', (SELECT count(*) FROM eventos WHERE fecha BETWEEN r.ini AND r.fin AND estado = 'realizado'),
    'capturas', (SELECT count(*) FROM capturas WHERE (creado_en AT TIME ZONE zona())::date BETWEEN r.ini AND r.fin),
    'ideas', (SELECT count(*) FROM ideas WHERE (fecha_captura AT TIME ZONE zona())::date BETWEEN r.ini AND r.fin),
    'conocimientos', (SELECT count(*) FROM conocimientos WHERE (fecha_captura AT TIME ZONE zona())::date BETWEEN r.ini AND r.fin)
  ) FROM r
$$;

CREATE OR REPLACE FUNCTION pct(a numeric, b numeric) RETURNS int LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE WHEN coalesce(b, 0) = 0 THEN NULL ELSE round(100 * a / b)::int END $$;

-- Resumen del domingo: rendimiento + tintero + lo que viene.
CREATE OR REPLACE FUNCTION resumen_semanal() RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE m jsonb := metricas_semana(0); s text; x record; tin text; prox text; d date; c int; tec jsonb := '[]'::jsonb;
BEGIN
  c := pct((m ->> 'tareas_a_tiempo')::numeric, (m ->> 'tareas_con_plazo')::numeric);
  s := format(E'📊 <b>Tu semana (%s – %s)</b>\n\n✅ Tareas completadas: <b>%s</b> (creadas: %s)\n🎯 Cumplidas a tiempo: <b>%s</b>\n⏰ Recordatorios confirmados: %s de %s\n📅 Eventos realizados: %s de %s\n💡 Ideas nuevas: %s · 📚 Aprendizajes: %s\n🔁 Reprogramaciones: %s\n',
    dia_corto((m ->> 'inicio')::date), dia_corto((m ->> 'fin')::date), m ->> 'tareas_completadas', m ->> 'tareas_creadas',
    coalesce(c || '%', 'sin tareas con plazo'), m ->> 'recordatorios_confirmados', m ->> 'recordatorios_enviados',
    m ->> 'eventos_realizados', m ->> 'eventos', m ->> 'ideas', m ->> 'conocimientos', m ->> 'reprogramaciones');
  FOR x IN SELECT * FROM tintero() LIMIT 10 LOOP
    tin := coalesce(tin || E'\n', '') || format('• <b>%s</b> %s <i>(%s)</i>', x.codigo, esc(x.titulo), x.motivo);
    IF jsonb_array_length(botones_para(x.codigo)) > 0 AND jsonb_array_length(tec) < 6 THEN
      tec := tec || jsonb_build_array(botones_para(x.codigo));
    END IF;
  END LOOP;
  s := s || E'\n🫙 <b>En el tintero</b>\n' || coalesce(tin, 'Nada. Semana cerrada 🙌') || E'\n';
  FOR d IN SELECT generate_series(hoy() + 1, hoy() + 7, interval '1 day')::date LOOP
    IF agenda_dia(d) IS NOT NULL THEN
      prox := coalesce(prox, '') || format(E'\n<b>%s</b>\n%s', dia_corto(d), agenda_dia(d));
    END IF;
  END LOOP;
  s := s || E'\n🗓 <b>Próximos 7 días</b>' || coalesce(prox, E'\nAgenda libre.')
       || format(E'\n\n📈 Panel completo: %s', (SELECT valor FROM config WHERE clave = 'panel_url'));
  RETURN jsonb_build_object('texto', s,
    'teclado', CASE WHEN jsonb_array_length(tec) > 0 THEN jsonb_build_object('inline_keyboard', tec) END);
END $$;

-- ---------------------------------------------------------------------
-- Cola de recordatorios (la consulta el workflow programado cada minuto)
-- ---------------------------------------------------------------------
-- Toma los recordatorios vencidos y los marca "enviando" de forma atómica para no duplicarlos.
-- También re-insiste (hasta 2 veces, cada 30 min) si un aviso no se confirmó.
CREATE OR REPLACE FUNCTION reclamar_recordatorios() RETURNS SETOF jsonb LANGUAGE plpgsql AS $$
DECLARE x recordatorios;
BEGIN
  FOR x IN
    UPDATE recordatorios SET estado = 'enviando',
                             insistencias = CASE WHEN estado = 'enviado' THEN insistencias + 1 ELSE insistencias END
    WHERE id IN (SELECT id FROM recordatorios
                 WHERE (estado = 'programado' AND programado_para <= now())
                    OR (estado = 'enviado' AND insistencias < 2 AND enviado_en < now() - interval '30 minutes')
                 ORDER BY programado_para LIMIT 20 FOR UPDATE SKIP LOCKED)
    RETURNING *
  LOOP
    RETURN NEXT jsonb_build_object(
      'id', x.id,
      'texto', format(E'%s <b>Recordatorio R%s</b>\n%s', CASE WHEN x.insistencias > 0 THEN '🔔🔔' ELSE '🔔' END, x.id, esc(x.mensaje))
               || CASE WHEN x.insistencias > 0 THEN E'\n<i>(te lo vuelvo a recordar)</i>' ELSE '' END,
      'teclado', jsonb_build_object('inline_keyboard', jsonb_build_array(botones_para('R' || x.id))));
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION marcar_recordatorio_enviado(p_id int, p_msg bigint) RETURNS void LANGUAGE sql AS $$
  UPDATE recordatorios SET estado = 'enviado', enviado_en = now(), telegram_msg_id = p_msg
  WHERE id = p_id AND estado = 'enviando'
$$;

-- Si Telegram falló, el recordatorio vuelve a la cola.
CREATE OR REPLACE FUNCTION liberar_recordatorios_trabados() RETURNS void LANGUAGE sql AS $$
  UPDATE recordatorios SET estado = CASE WHEN enviado_en IS NULL THEN 'programado' ELSE 'enviado' END
  WHERE estado = 'enviando' AND programado_para < now() - interval '5 minutes'
$$;

-- ---------------------------------------------------------------------
-- Enrutador de comandos de Telegram
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ayuda() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('texto', E'🧠 <b>Tu segundo cerebro</b>\nMándame un <b>audio</b> o un texto con lo que tengas en la cabeza. Yo lo ordeno en tareas, recordatorios, eventos, ideas, conocimientos u otros.\n\n<b>Ver</b>\n/hoy · /semana · /tintero\n/tareas · /recordatorios · /eventos\n/ideas · /conocimientos · /otros · /revision\n/buscar palabra · /ver T12 · /panel\n\n<b>Actuar</b>\n/hecho T12 · /encurso T12 · /pendiente T12\n/reprogramar T12 viernes · /reprogramar R3 mañana 9 · /reprogramar R3 +30m\n/cancelar R3 · /cancelar E2\n/mover T12 idea  (cambiar categoría)\n/idea I4 exploracion|desarrollo|descartada\n\n<i>Códigos: T tarea · R recordatorio · E evento · I idea · C conocimiento · O otros · V revisión</i>')
$$;

CREATE OR REPLACE FUNCTION comando_telegram(p_texto text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  partes text[];
  cmd text;
  a1 text;
  resto text;
  d date;
  s text;
  est text;
  n int;
BEGIN
  p_texto := btrim(coalesce(p_texto, ''));
  partes := regexp_split_to_array(p_texto, '\s+');
  cmd := lower(regexp_replace(partes[1], '@.*$', ''));             -- quita "@MiBot"
  cmd := translate(cmd, 'áéíóúñ', 'aeioun');
  a1 := upper(coalesce(partes[2], ''));
  resto := btrim(substr(p_texto, length(partes[1]) + 1));
  resto := btrim(substr(resto, CASE WHEN a1 ~ '^[TREICOV]\d+$' THEN length(a1) + 1 ELSE 1 END));

  CASE cmd
    WHEN '/start', '/ayuda', '/help' THEN RETURN ayuda();
    WHEN '/hoy' THEN
      RETURN resumen_diario();
    WHEN '/semana' THEN
      s := '';
      FOR d IN SELECT generate_series(hoy(), hoy() + 6, interval '1 day')::date LOOP
        s := s || format(E'\n<b>%s</b>\n%s', dia_corto(d), coalesce(agenda_dia(d), E'—\n'));
      END LOOP;
      RETURN jsonb_build_object('texto', E'🗓 <b>Próximos 7 días</b>' || s);
    WHEN '/tintero' THEN
      RETURN jsonb_build_object('texto', E'🫙 <b>Quedó en el tintero</b>\n' ||
        coalesce((SELECT string_agg(format('• <b>%s</b> %s <i>(%s)</i>', codigo, esc(titulo), motivo), E'\n') FROM tintero()),
                 'Nada atrasado. Vas al día 🙌'),
        'teclado', (SELECT jsonb_build_object('inline_keyboard', jsonb_agg(botones_para(codigo)))
                    FROM (SELECT codigo FROM tintero() WHERE tipo IN ('tarea', 'recordatorio', 'evento') LIMIT 8) z));
    WHEN '/tareas' THEN RETURN listar('tareas', lower(resto));
    WHEN '/recordatorios' THEN RETURN listar('recordatorios');
    WHEN '/eventos', '/agenda' THEN RETURN listar('eventos');
    WHEN '/ideas' THEN RETURN listar('ideas', lower(resto));
    WHEN '/conocimientos', '/aprendizajes' THEN RETURN listar('conocimientos', resto);
    WHEN '/otros', '/archivo' THEN RETURN listar('otros');
    WHEN '/revision' THEN RETURN listar('revision');
    WHEN '/buscar' THEN
      IF resto = '' THEN RETURN jsonb_build_object('texto', 'Uso: /buscar palabra'); END IF;
      RETURN buscar(resto);
    WHEN '/ver' THEN RETURN ver_registro(a1);
    WHEN '/hecho', '/listo', '/ok' THEN RETURN cambiar_estado(a1, 'hecho');
    WHEN '/encurso' THEN RETURN cambiar_estado(a1, 'encurso');
    WHEN '/pendiente' THEN RETURN cambiar_estado(a1, 'pendiente');
    WHEN '/cancelar' THEN RETURN cambiar_estado(a1, 'cancelar');
    WHEN '/norealizado' THEN RETURN cambiar_estado(a1, 'no');
    WHEN '/reprogramar', '/mover_fecha', '/posponer' THEN
      IF resto = '' THEN RETURN jsonb_build_object('texto', 'Uso: /reprogramar T12 viernes  ·  /reprogramar R3 mañana 9'); END IF;
      RETURN reprogramar(a1, resto);
    WHEN '/mover', '/reclasificar' THEN
      IF a1 !~ '^[TREICOV]\d+$' OR resto = '' THEN
        RETURN jsonb_build_object('texto', 'Uso: /mover T12 idea  (categorías: tarea, recordatorio, evento, idea, conocimiento, otros)');
      END IF;
      RETURN reclasificar(a1, resto);
    WHEN '/idea' THEN
      est := CASE WHEN lower(resto) LIKE 'explor%' THEN 'en exploración' WHEN lower(resto) LIKE 'desarroll%' THEN 'en desarrollo'
                  WHEN lower(resto) LIKE 'descart%' THEN 'descartada' WHEN lower(resto) LIKE 'nueva%' THEN 'nueva' END;
      IF a1 !~ '^I\d+$' OR est IS NULL THEN
        RETURN jsonb_build_object('texto', 'Uso: /idea I4 exploracion | desarrollo | descartada | nueva');
      END IF;
      UPDATE ideas SET estado = est WHERE id = substr(a1, 2)::int;
      GET DIAGNOSTICS n = ROW_COUNT;
      RETURN jsonb_build_object('texto', CASE WHEN n > 0 THEN format('💡 <b>%s</b> ahora está <b>%s</b>.', a1, est) ELSE 'No encontré ' || a1 END);
    WHEN '/panel', '/dashboard' THEN
      RETURN jsonb_build_object('texto', '📈 Tu panel semanal: ' || (SELECT valor FROM config WHERE clave = 'panel_url'));
    ELSE
      RETURN jsonb_build_object('texto', 'No conozco ese comando. Escribe /ayuda');
  END CASE;
END $$;

-- Botones (callback_data): ok:T3 · man:T3 · lun:T3 · snz:R3:60 · no:E3 · cat:V3:tarea
CREATE OR REPLACE FUNCTION accion_boton(p_data text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p text[] := string_to_array(coalesce(p_data, ''), ':');
BEGIN
  CASE p[1]
    WHEN 'ok'  THEN RETURN cambiar_estado(p[2], 'hecho');
    WHEN 'no'  THEN RETURN cambiar_estado(p[2], 'no');
    WHEN 'cur' THEN RETURN cambiar_estado(p[2], 'encurso');
    WHEN 'man' THEN RETURN reprogramar(p[2], 'mañana');
    WHEN 'lun' THEN RETURN reprogramar(p[2], 'lunes');
    WHEN 'snz' THEN RETURN reprogramar(p[2], '+' || coalesce(p[3], '60') || 'm');
    WHEN 'cat' THEN RETURN reclasificar(p[2], p[3]);
    ELSE RETURN jsonb_build_object('texto', 'Botón desconocido.');
  END CASE;
END $$;

-- ---------------------------------------------------------------------
-- Panel semanal (lo sirve el webhook de n8n al dashboard)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION panel_semanal(p_offset int DEFAULT 0) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH m AS (SELECT metricas_semana(p_offset) AS j),
  r AS (SELECT (j ->> 'inicio')::date AS ini, (j ->> 'fin')::date AS fin FROM m),
  dias AS (SELECT generate_series(r.ini, r.fin, interval '1 day')::date AS d FROM r)
  SELECT jsonb_build_object(
    'generado', to_char(ahora_local(), 'YYYY-MM-DD"T"HH24:MI'),
    'hoy', hoy(),
    'offset', p_offset,
    'metricas', (SELECT j FROM m),
    'por_dia', (SELECT jsonb_agg(jsonb_build_object(
        'fecha', d, 'dia', dia_corto(d),
        'completadas', (SELECT count(*) FROM tareas WHERE (completada_en AT TIME ZONE zona())::date = d),
        'capturas', (SELECT count(*) FROM capturas WHERE (creado_en AT TIME ZONE zona())::date = d),
        'items', coalesce((SELECT jsonb_agg(x ORDER BY x ->> 'hora' NULLS FIRST) FROM (
            SELECT jsonb_build_object('codigo', 'E' || id, 'tipo', 'evento', 'titulo', nombre, 'hora', hhmm(hora_inicio), 'estado', estado) x
              FROM eventos WHERE fecha = d AND estado <> 'cancelado'
            UNION ALL
            SELECT jsonb_build_object('codigo', 'R' || id, 'tipo', 'recordatorio', 'titulo', mensaje, 'hora', hhmm(hora), 'estado', estado)
              FROM recordatorios WHERE fecha = d AND estado <> 'cancelado'
            UNION ALL
            SELECT jsonb_build_object('codigo', 'T' || id, 'tipo', 'tarea', 'titulo', titulo, 'hora', NULL, 'estado', estado,
                                      'prioridad', prioridad)
              FROM tareas WHERE fecha_limite = d) z), '[]'::jsonb)
      ) ORDER BY d) FROM dias),
    'tintero', coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM tintero() t), '[]'::jsonb),
    'sin_fecha', coalesce((SELECT jsonb_agg(jsonb_build_object('codigo', 'T' || id, 'titulo', titulo, 'estado', estado,
                                                               'proyecto', proyecto, 'prioridad', prioridad) ORDER BY fecha_captura)
                           FROM tareas WHERE estado <> 'completada' AND fecha_limite IS NULL), '[]'::jsonb),
    'tendencia', (SELECT jsonb_agg(jsonb_build_object(
        'inicio', mm ->> 'inicio',
        'completadas', (mm ->> 'tareas_completadas')::int,
        'creadas', (mm ->> 'tareas_creadas')::int,
        'cumplimiento', pct((mm ->> 'tareas_a_tiempo')::numeric, (mm ->> 'tareas_con_plazo')::numeric)) ORDER BY o)
      FROM (SELECT o, metricas_semana(p_offset + o) AS mm FROM generate_series(-7, 0) o) w),
    'ideas', coalesce((SELECT jsonb_agg(jsonb_build_object('codigo', 'I' || id, 'titulo', titulo, 'estado', estado, 'area', area_tematica))
                       FROM (SELECT * FROM ideas WHERE estado <> 'descartada' ORDER BY fecha_captura DESC LIMIT 6) z), '[]'::jsonb),
    'conocimientos', coalesce((SELECT jsonb_agg(jsonb_build_object('codigo', 'C' || id, 'titulo', titulo, 'area', area_tematica))
                               FROM (SELECT * FROM conocimientos ORDER BY fecha_captura DESC LIMIT 6) z), '[]'::jsonb),
    'revision', (SELECT count(*) FROM revision WHERE estado = 'pendiente'))
$$;

-- Acciones del panel: { "accion": "hecho|reprogramar|no|cancelar", "codigo": "T3", "valor": "mañana" }
CREATE OR REPLACE FUNCTION accion_panel(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE cod text := upper(coalesce(jtxt(p, 'codigo'), '')); acc text := jtxt(p, 'accion');
BEGIN
  IF cod !~ '^[TRE]\d+$' THEN RETURN jsonb_build_object('ok', false, 'texto', 'Código inválido'); END IF;
  RETURN jsonb_build_object('ok', true) || CASE acc
    WHEN 'hecho' THEN cambiar_estado(cod, 'hecho')
    WHEN 'no' THEN cambiar_estado(cod, 'no')
    WHEN 'reprogramar' THEN reprogramar(cod, coalesce(jtxt(p, 'valor'), 'mañana'))
    ELSE jsonb_build_object('ok', false, 'texto', 'Acción no permitida desde el panel') END;
END $$;
