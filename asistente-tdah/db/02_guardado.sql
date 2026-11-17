-- =====================================================================
-- Utilidades + funciones de guardado que llama cada rama del Switch de n8n.
-- Cada función recibe el ítem completo de n8n como jsonb:
--   { "captura_id": 1, "ejecucion_id": "123", "registro": { ...registro validado... } }
-- y devuelve { codigo, categoria, titulo, destino }.
-- =====================================================================

CREATE OR REPLACE FUNCTION zona() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce((SELECT valor FROM config WHERE clave = 'zona_horaria'), 'America/Santiago') $$;

CREATE OR REPLACE FUNCTION ahora_local() RETURNS timestamp LANGUAGE sql STABLE AS
$$ SELECT now() AT TIME ZONE zona() $$;

CREATE OR REPLACE FUNCTION hoy() RETURNS date LANGUAGE sql STABLE AS
$$ SELECT ahora_local()::date $$;

-- Escapa texto para mensajes de Telegram en modo HTML.
CREATE OR REPLACE FUNCTION esc(t text) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') $$;

CREATE OR REPLACE FUNCTION dia_corto(d date) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT (ARRAY['dom','lun','mar','mié','jue','vie','sáb'])[extract(dow FROM d)::int + 1] || ' ' || to_char(d, 'DD/MM') $$;

CREATE OR REPLACE FUNCTION dia_largo(d date) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT (ARRAY['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow FROM d)::int + 1] $$;

CREATE OR REPLACE FUNCTION hhmm(t time) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT to_char(t, 'HH24:MI') $$;

CREATE OR REPLACE FUNCTION jtxt(p jsonb, k text) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT nullif(btrim(p ->> k), '') $$;

CREATE OR REPLACE FUNCTION jarr(p jsonb, k text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
$$ SELECT coalesce(array(SELECT jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(p -> k) = 'array' THEN p -> k ELSE '[]'::jsonb END)), '{}') $$;

CREATE OR REPLACE FUNCTION etiquetas_txt(e text[]) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE WHEN coalesce(array_length(e, 1), 0) = 0 THEN '' ELSE ' · #' || array_to_string(e, ' #') END $$;

-- Interpreta fechas escritas a mano en Telegram: hoy, mañana, pasado mañana, lunes…domingo,
-- "proxima semana", +3 (días), 20/11, 20-11-2026, 2026-11-20.
CREATE OR REPLACE FUNCTION interpretar_fecha(p text) RETURNS date LANGUAGE plpgsql STABLE AS $$
DECLARE
  s text := lower(btrim(coalesce(p, '')));
  h date := hoy();
  m text[];
  dias text[] := ARRAY['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
  i int;
  y int;
BEGIN
  s := translate(s, 'áéíóúñ', 'aeioun');
  IF s IN ('hoy') THEN RETURN h; END IF;
  IF s IN ('manana', 'man') THEN RETURN h + 1; END IF;
  IF s IN ('pasado manana', 'pasado') THEN RETURN h + 2; END IF;
  IF s IN ('proxima semana', 'semana', 'prox') THEN RETURN (date_trunc('week', h) + interval '7 days')::date; END IF;
  m := regexp_match(s, '^\+(\d{1,3})d?$');
  IF m IS NOT NULL THEN RETURN h + m[1]::int; END IF;
  FOR i IN 1..7 LOOP
    IF s = dias[i] OR s = 'el ' || dias[i] OR s = left(dias[i], 3) THEN
      -- siguiente día con ese nombre (si hoy es ese día, el de la próxima semana)
      RETURN h + (((i - 1) - extract(dow FROM h)::int + 7) % 7 + CASE WHEN (i - 1) = extract(dow FROM h)::int THEN 7 ELSE 0 END);
    END IF;
  END LOOP;
  m := regexp_match(s, '^(\d{4})-(\d{1,2})-(\d{1,2})$');
  IF m IS NOT NULL THEN RETURN make_date(m[1]::int, m[2]::int, m[3]::int); END IF;
  m := regexp_match(s, '^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$');
  IF m IS NOT NULL THEN
    y := coalesce(m[3]::int, extract(year FROM h)::int);
    IF y < 100 THEN y := y + 2000; END IF;
    IF m[3] IS NULL AND make_date(y, m[2]::int, m[1]::int) < h THEN y := y + 1; END IF;
    RETURN make_date(y, m[2]::int, m[1]::int);
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------
-- Captura
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guardar_captura(p jsonb) RETURNS int LANGUAGE plpgsql AS $$
DECLARE nid int;
BEGIN
  INSERT INTO capturas (ejecucion_id, origen, transcripcion_original, transcripcion_corregida,
                        resumen_general, json_clasificador, errores_validacion)
  VALUES (jtxt(p, 'ejecucion_id'), coalesce(jtxt(p, 'origen'), 'texto'),
          coalesce(p ->> 'transcripcion_original', ''), jtxt(p, 'transcripcion_corregida'),
          jtxt(p, 'resumen_general'), p -> 'json_clasificador', p -> 'errores')
  RETURNING id INTO nid;
  RETURN nid;
END $$;

-- ---------------------------------------------------------------------
-- Guardado por categoría (una función por rama del Switch)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guardar_tarea(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb := p -> 'registro'; t tareas;
BEGIN
  INSERT INTO tareas (captura_id, ejecucion_id, id_local, relacionado_ref, titulo, descripcion,
                      fecha_limite, prioridad, estado, proyecto, etiquetas, completada_en)
  VALUES ((p ->> 'captura_id')::int, jtxt(p, 'ejecucion_id'), jtxt(r, 'id_local'), jtxt(r, 'relacionado_con'),
          jtxt(r, 'titulo'), jtxt(r, 'contenido'), jtxt(r, 'fecha')::date, jtxt(r, 'prioridad'),
          coalesce(jtxt(r, 'estado'), 'pendiente'), jtxt(r, 'proyecto'), jarr(r, 'etiquetas'),
          CASE WHEN jtxt(r, 'estado') = 'completada' THEN now() END)
  RETURNING * INTO t;
  RETURN jsonb_build_object('codigo', 'T' || t.id, 'categoria', 'tarea', 'titulo', t.titulo, 'destino', 'Bandeja de tareas');
END $$;

CREATE OR REPLACE FUNCTION guardar_recordatorio(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb := p -> 'registro'; x recordatorios; f date; h time;
BEGIN
  f := jtxt(r, 'fecha')::date;
  h := jtxt(r, 'hora')::time;
  INSERT INTO recordatorios (captura_id, ejecucion_id, id_local, relacionado_ref, mensaje, fecha, hora, programado_para)
  VALUES ((p ->> 'captura_id')::int, jtxt(p, 'ejecucion_id'), jtxt(r, 'id_local'), jtxt(r, 'relacionado_con'),
          coalesce(jtxt(r, 'contenido'), jtxt(r, 'titulo')), f, h, (f + h) AT TIME ZONE zona())
  RETURNING * INTO x;
  RETURN jsonb_build_object('codigo', 'R' || x.id, 'categoria', 'recordatorio', 'titulo', x.mensaje, 'destino', 'Notificaciones de Telegram');
END $$;

CREATE OR REPLACE FUNCTION guardar_evento(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb := p -> 'registro'; e eventos;
BEGIN
  INSERT INTO eventos (captura_id, ejecucion_id, id_local, relacionado_ref, nombre, descripcion, fecha,
                       hora_inicio, hora_termino, lugar, participantes, etiquetas,
                       google_event_id, google_link, calendar_error)
  VALUES ((p ->> 'captura_id')::int, jtxt(p, 'ejecucion_id'), jtxt(r, 'id_local'), jtxt(r, 'relacionado_con'),
          jtxt(r, 'titulo'), jtxt(r, 'contenido'), jtxt(r, 'fecha')::date, jtxt(r, 'hora')::time,
          jtxt(r, 'hora_fin')::time, jtxt(r, 'lugar'), jarr(r, 'participantes'), jarr(r, 'etiquetas'),
          jtxt(p, 'google_event_id'), jtxt(p, 'google_link'), jtxt(p, 'calendar_error'))
  RETURNING * INTO e;
  RETURN jsonb_build_object('codigo', 'E' || e.id, 'categoria', 'evento', 'titulo', e.nombre, 'destino', 'Google Calendar');
END $$;

CREATE OR REPLACE FUNCTION guardar_idea(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb := p -> 'registro'; i ideas;
BEGIN
  INSERT INTO ideas (captura_id, ejecucion_id, id_local, relacionado_ref, titulo, descripcion, area_tematica,
                     proyecto, potencial_aplicacion, etiquetas, estado)
  VALUES ((p ->> 'captura_id')::int, jtxt(p, 'ejecucion_id'), jtxt(r, 'id_local'), jtxt(r, 'relacionado_con'),
          jtxt(r, 'titulo'), coalesce(jtxt(r, 'contenido'), jtxt(r, 'titulo')), jtxt(r, 'area_tematica'),
          jtxt(r, 'proyecto'), jtxt(r, 'aplicacion'), jarr(r, 'etiquetas'), coalesce(jtxt(r, 'estado'), 'nueva'))
  RETURNING * INTO i;
  RETURN jsonb_build_object('codigo', 'I' || i.id, 'categoria', 'idea', 'titulo', i.titulo, 'destino', 'Biblioteca de ideas');
END $$;

CREATE OR REPLACE FUNCTION guardar_conocimiento(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb := p -> 'registro'; c conocimientos;
BEGIN
  INSERT INTO conocimientos (captura_id, ejecucion_id, id_local, relacionado_ref, titulo, concepto_principal,
                             explicacion, fuente, area_tematica, aplicaciones, etiquetas)
  VALUES ((p ->> 'captura_id')::int, jtxt(p, 'ejecucion_id'), jtxt(r, 'id_local'), jtxt(r, 'relacionado_con'),
          jtxt(r, 'titulo'), jtxt(r, 'concepto_principal'), coalesce(jtxt(r, 'contenido'), jtxt(r, 'titulo')),
          jtxt(r, 'fuente'), jtxt(r, 'area_tematica'), jtxt(r, 'aplicacion'), jarr(r, 'etiquetas'))
  RETURNING * INTO c;
  RETURN jsonb_build_object('codigo', 'C' || c.id, 'categoria', 'conocimiento', 'titulo', c.titulo, 'destino', 'Biblioteca de conocimientos');
END $$;

CREATE OR REPLACE FUNCTION guardar_otros(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb := p -> 'registro'; o otros; tr text;
BEGIN
  SELECT transcripcion_original INTO tr FROM capturas WHERE id = (p ->> 'captura_id')::int;
  INSERT INTO otros (captura_id, ejecucion_id, id_local, relacionado_ref, titulo, transcripcion, resumen, tema, etiquetas)
  VALUES ((p ->> 'captura_id')::int, jtxt(p, 'ejecucion_id'), jtxt(r, 'id_local'), jtxt(r, 'relacionado_con'),
          jtxt(r, 'titulo'), coalesce(tr, jtxt(r, 'contenido')), jtxt(r, 'contenido'),
          jtxt(r, 'area_tematica'), jarr(r, 'etiquetas'))
  RETURNING * INTO o;
  RETURN jsonb_build_object('codigo', 'O' || o.id, 'categoria', 'otros', 'titulo', o.titulo, 'destino', 'Archivo general');
END $$;

-- Teclado de categorías para resolver una revisión con un toque.
CREATE OR REPLACE FUNCTION teclado_categorias(cod text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('inline_keyboard', jsonb_build_array(
    jsonb_build_array(
      jsonb_build_object('text', '✅ Tarea', 'callback_data', 'cat:' || cod || ':tarea'),
      jsonb_build_object('text', '⏰ Recordatorio', 'callback_data', 'cat:' || cod || ':recordatorio'),
      jsonb_build_object('text', '📅 Evento', 'callback_data', 'cat:' || cod || ':evento')),
    jsonb_build_array(
      jsonb_build_object('text', '💡 Idea', 'callback_data', 'cat:' || cod || ':idea'),
      jsonb_build_object('text', '📚 Conocimiento', 'callback_data', 'cat:' || cod || ':conocimiento'),
      jsonb_build_object('text', '📦 Otros', 'callback_data', 'cat:' || cod || ':otros'))))
$$;

-- Revisión: guarda el registro dudoso y devuelve el mensaje con la pregunta para Telegram.
CREATE OR REPLACE FUNCTION guardar_revision(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb := p -> 'registro'; v revision; txt text; tec jsonb;
BEGIN
  INSERT INTO revision (captura_id, ejecucion_id, id_local, relacionado_ref, categoria_sugerida, titulo, registro,
                        tipo, motivo, pregunta)
  VALUES ((p ->> 'captura_id')::int, jtxt(p, 'ejecucion_id'), jtxt(r, 'id_local'), jtxt(r, 'relacionado_con'),
          jtxt(r, 'categoria'), coalesce(jtxt(r, 'titulo'), left(jtxt(r, 'contenido'), 80)), r,
          coalesce(jtxt(r, 'tipo_revision'), 'categoria'), jtxt(r, 'motivo_revision'),
          coalesce(jtxt(r, 'pregunta'), '¿Dónde guardo esto?'))
  RETURNING * INTO v;
  txt := format(E'🤔 <b>V%s</b> · %s\n<i>%s</i>', v.id, esc(v.pregunta), esc(left(coalesce(r ->> 'contenido', v.titulo), 400)));
  IF v.tipo = 'aclaracion' THEN
    txt := txt || E'\n\n↩️ <b>Responde a este mensaje</b> y lo completo.';
    tec := jsonb_build_object('force_reply', true, 'input_field_placeholder', 'Ej.: mañana a las 10');
  ELSE
    txt := txt || format(E'\nSugerencia del modelo: <b>%s</b>. Toca una categoría:', esc(coalesce(v.categoria_sugerida, '—')));
    tec := teclado_categorias('V' || v.id);
  END IF;
  RETURN jsonb_build_object('codigo', 'V' || v.id, 'id', v.id, 'categoria', 'revision', 'titulo', v.titulo,
                            'destino', 'Bandeja de revisión', 'texto', txt, 'teclado', tec);
END $$;

CREATE OR REPLACE FUNCTION registrar_msg_revision(p_id int, p_msg bigint) RETURNS void LANGUAGE sql AS
$$ UPDATE revision SET telegram_msg_id = p_msg WHERE id = p_id $$;

-- Si el mensaje responde a una pregunta de revisión, arma el texto combinado para reclasificar.
CREATE OR REPLACE FUNCTION preparar_aclaracion(p_reply_msg bigint, p_texto text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v revision;
BEGIN
  IF p_reply_msg IS NOT NULL THEN
    SELECT * INTO v FROM revision WHERE telegram_msg_id = p_reply_msg AND estado = 'pendiente' LIMIT 1;
  END IF;
  IF v.id IS NULL THEN
    RETURN jsonb_build_object('texto', p_texto, 'origen', 'texto', 'revision', NULL);
  END IF;
  UPDATE revision SET estado = 'resuelta', resuelto_en = now() WHERE id = v.id;
  RETURN jsonb_build_object(
    'origen', 'aclaracion', 'revision', 'V' || v.id,
    'texto', format('Tenía pendiente este registro (categoría sugerida: %s): "%s". Me preguntaste: "%s". Mi respuesta: "%s".',
                    coalesce(v.categoria_sugerida, 'sin definir'), coalesce(v.registro ->> 'contenido', v.titulo),
                    v.pregunta, p_texto));
END $$;

-- ---------------------------------------------------------------------
-- Confirmación final: qué se creó y dónde quedó (una sola vez por ejecución).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION detalle_codigo(cod text) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE pre text := left(cod, 1); n int := substr(cod, 2)::int; s text;
BEGIN
  CASE pre
    WHEN 'T' THEN SELECT concat_ws(' · ', CASE WHEN fecha_limite IS NOT NULL THEN 'vence ' || dia_corto(fecha_limite) END,
                                     CASE WHEN prioridad IS NOT NULL THEN 'prioridad ' || prioridad END, proyecto)
                  INTO s FROM tareas WHERE id = n;
    WHEN 'R' THEN SELECT 'te aviso el ' || dia_corto(fecha) || ' a las ' || hhmm(hora) INTO s FROM recordatorios WHERE id = n;
    WHEN 'E' THEN SELECT dia_corto(fecha) || coalesce(' ' || hhmm(hora_inicio), ' (todo el día)')
                         || coalesce('–' || hhmm(hora_termino), '') || coalesce(' · ' || lugar, '')
                         || CASE WHEN google_event_id IS NOT NULL THEN ' · en Google Calendar ✓'
                                 ELSE ' · ⚠️ no se pudo crear en Google Calendar (quedó guardado aquí)' END
                  INTO s FROM eventos WHERE id = n;
    WHEN 'I' THEN SELECT concat_ws(' · ', estado, area_tematica, proyecto) INTO s FROM ideas WHERE id = n;
    WHEN 'C' THEN SELECT concat_ws(' · ', area_tematica, 'fuente: ' || fuente) INTO s FROM conocimientos WHERE id = n;
    WHEN 'O' THEN SELECT tema INTO s FROM otros WHERE id = n;
    WHEN 'V' THEN s := 'esperando tu respuesta';
    ELSE s := NULL;
  END CASE;
  RETURN nullif(s, '');
END $$;

CREATE OR REPLACE FUNCTION confirmacion(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  ejec text := jtxt(p, 'ejecucion_id');
  lineas text := '';
  n int := 0;
  x record;
  icono text;
BEGIN
  -- 1) Relacionar registros del mismo audio (p. ej. tarea que sale de una idea).
  INSERT INTO vinculos (origen, destino)
  SELECT a.codigo, b.codigo
  FROM v_registros a JOIN v_registros b
    ON b.captura_id = a.captura_id AND b.id_local = a.relacionado_ref AND b.codigo <> a.codigo
  WHERE a.ejecucion_id = ejec AND a.relacionado_ref IS NOT NULL
  ON CONFLICT DO NOTHING;
  UPDATE tareas t SET idea_id = i.id
  FROM ideas i
  WHERE t.ejecucion_id = ejec AND i.captura_id = t.captura_id AND i.id_local = t.relacionado_ref;

  -- 2) Mensaje de confirmación.
  FOR x IN SELECT * FROM v_registros WHERE ejecucion_id = ejec ORDER BY creado_en, codigo LOOP
    n := n + 1;
    icono := CASE x.categoria WHEN 'tarea' THEN '✅' WHEN 'recordatorio' THEN '⏰' WHEN 'evento' THEN '📅'
                              WHEN 'idea' THEN '💡' WHEN 'conocimiento' THEN '📚' WHEN 'otros' THEN '📦' ELSE '🤔' END;
    lineas := lineas || format(E'%s <b>%s</b> %s\n     → %s%s\n', icono, x.codigo, esc(x.titulo), x.destino,
                               coalesce(' · ' || esc(detalle_codigo(x.codigo)), ''));
    IF x.relacionado_ref IS NOT NULL THEN
      lineas := lineas || coalesce((SELECT '     🔗 relacionado con ' || string_agg(destino, ', ')
                                    FROM vinculos WHERE origen = x.codigo) || E'\n', '');
    END IF;
  END LOOP;

  IF n = 0 THEN
    RETURN jsonb_build_object('texto', '⚠️ No se guardó ningún registro. Revisa la ejecución en n8n.');
  END IF;
  RETURN jsonb_build_object('texto',
    format(E'📥 <b>Guardé %s %s</b>\n%s\n%s\n<i>¿Algo quedó mal?</i> /mover CÓDIGO categoría · /ver CÓDIGO',
           n, CASE WHEN n = 1 THEN 'registro' ELSE 'registros' END,
           coalesce('📝 <i>' || esc(jtxt(p, 'resumen')) || E'</i>\n', ''), lineas));
END $$;
