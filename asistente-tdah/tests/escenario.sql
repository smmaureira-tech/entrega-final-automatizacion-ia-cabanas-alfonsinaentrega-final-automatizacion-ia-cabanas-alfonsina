-- Escenario de prueba de la base de datos: simula lo que hace n8n con un audio
-- que trae varias categorías, y luego los comandos y botones de Telegram.
-- Uso: tests/test-sql.sh   (crea una base temporal, carga db/*.sql y ejecuta esto)
\set ON_ERROR_STOP 1
\pset pager off

-- 1) Captura + un registro por categoría (lo que hace cada rama del Switch)
SELECT guardar_captura('{"ejecucion_id":"x1","origen":"voz","transcripcion_original":"audio de prueba","resumen_general":"varias cosas"}') AS cap \gset
SELECT guardar_idea(jsonb_build_object('captura_id', :cap, 'ejecucion_id', 'x1', 'registro',
  '{"id_local":"r1","titulo":"Tours de estrellas","contenido":"Tours nocturnos en las cabañas","estado":"nueva","proyecto":"cabañas","etiquetas":["turismo"]}'::jsonb));
SELECT guardar_tarea(jsonb_build_object('captura_id', :cap, 'ejecucion_id', 'x1', 'registro',
  jsonb_build_object('id_local','r2','relacionado_con','r1','titulo','Cotizar telescopio','contenido','Averiguar precio','fecha', hoy() + 1,'estado','pendiente','etiquetas','["cotización"]'::jsonb)));
SELECT guardar_recordatorio(jsonb_build_object('captura_id', :cap, 'ejecucion_id', 'x1', 'registro',
  jsonb_build_object('id_local','r3','titulo','Sacar la ropa','contenido','Sacar la ropa','fecha', hoy() - 1,'hora','08:00')));
SELECT guardar_evento(jsonb_build_object('captura_id', :cap, 'ejecucion_id', 'x1', 'google_event_id', 'g123', 'google_link', 'https://calendar.google.com/x',
  'registro', jsonb_build_object('id_local','r4','titulo','Reunión contador','contenido','Reunión','fecha', hoy() + 2,'hora','11:00','participantes','["contador"]'::jsonb)));
SELECT guardar_conocimiento(jsonb_build_object('captura_id', :cap, 'ejecucion_id', 'x1', 'registro',
  '{"id_local":"r5","titulo":"Webhooks","concepto_principal":"Un webhook es una llamada HTTP que un sistema hace a otro cuando ocurre un evento","contenido":"Funcionan como notificaciones push entre servidores.","area_tematica":"tecnología","etiquetas":["webhooks"]}'::jsonb));
SELECT guardar_otros(jsonb_build_object('captura_id', :cap, 'ejecucion_id', 'x1', 'registro',
  '{"id_local":"r6","titulo":"Clave wifi cabaña 2","contenido":"La clave del wifi de la cabaña 2","area_tematica":"cabañas"}'::jsonb));
SELECT guardar_revision(jsonb_build_object('captura_id', :cap, 'ejecucion_id', 'x1', 'registro',
  '{"id_local":"r7","categoria":"recordatorio","titulo":"Llamar al dentista","contenido":"Llamar al dentista","tipo_revision":"aclaracion","pregunta":"¿Cuándo te aviso?","motivo_revision":"sin hora"}'::jsonb)) ->> 'texto' AS revision_msg;

-- 2) Confirmación final (una vez por ejecución) + vínculo idea ↔ tarea
SELECT confirmacion('{"ejecucion_id":"x1","resumen":"Una idea, una tarea, un evento…"}') ->> 'texto' AS confirmacion;
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM vinculos WHERE origen = 'T1' AND destino = 'I1') = 1, 'falta vínculo T1→I1';
  ASSERT (SELECT idea_id FROM tareas WHERE id = 1) = 1, 'tarea no quedó relacionada con la idea';
END $$;

-- 3) Cola de recordatorios: el de ayer debe salir una sola vez
SELECT reclamar_recordatorios() ->> 'texto' AS aviso;
DO $$ BEGIN
  ASSERT (SELECT estado FROM recordatorios WHERE id = 1) = 'enviando';
  ASSERT (SELECT count(*) FROM reclamar_recordatorios()) = 0, 'recordatorio duplicado';
END $$;
SELECT marcar_recordatorio_enviado(1, 999);

-- 4) Aclaración por respuesta a la pregunta
SELECT registrar_msg_revision(1, 555);
SELECT preparar_aclaracion(555, 'mañana a las 10') AS aclaracion;
DO $$ BEGIN ASSERT (SELECT estado FROM revision WHERE id = 1) = 'resuelta'; END $$;
SELECT preparar_aclaracion(777, 'texto normal') ->> 'origen' AS origen_normal;

-- 5) Comandos y botones
SELECT comando_telegram('/tareas') ->> 'texto' AS tareas;
SELECT comando_telegram('/hecho T1') ->> 'texto' AS hecho;
SELECT accion_boton('snz:R1:60') ->> 'texto' AS posponer;
DO $$ BEGIN ASSERT (SELECT estado FROM recordatorios WHERE id = 1) = 'programado'; END $$;
SELECT comando_telegram('/reprogramar T1 viernes') ->> 'texto' AS reprogramar;
SELECT comando_telegram('/conocimientos webhook') ->> 'texto' AS busqueda_conocimiento;
SELECT comando_telegram('/ver T1') ->> 'texto' AS ver;
SELECT comando_telegram('/idea I1 exploracion') ->> 'texto' AS idea_estado;
SELECT comando_telegram('/buscar wifi') ->> 'texto' AS buscar;

-- 6) Reclasificación manual: O1 → conocimiento (n8n recibe "redistribuir")
SELECT comando_telegram('/mover O1 conocimiento') AS mover;
DO $$ BEGIN ASSERT NOT EXISTS (SELECT 1 FROM otros WHERE id = 1); ASSERT (SELECT count(*) FROM reclasificaciones) = 1; END $$;
SELECT comando_telegram('/mover E1 tarea') -> 'eliminar_evento_google' AS borrar_de_calendar;

-- 7) Fechas escritas a mano
SELECT interpretar_fecha('mañana') = hoy() + 1 AS manana_ok,
       interpretar_fecha('+3') = hoy() + 3 AS mas3_ok,
       extract(dow FROM interpretar_fecha('lunes')) = 1 AS lunes_ok,
       interpretar_fecha('lunes') > hoy() AS lunes_futuro,
       interpretar_fecha('2026-12-24') = '2026-12-24'::date AS iso_ok,
       interpretar_fecha('cualquier cosa') IS NULL AS basura_ok;

-- 8) Tintero, resúmenes y panel
INSERT INTO tareas (titulo, fecha_limite) VALUES ('Tarea olvidada', hoy() - 3);
SELECT * FROM tintero();
SELECT resumen_diario() ->> 'texto' AS diario;
SELECT resumen_noche() ->> 'texto' AS noche;
SELECT resumen_semanal() ->> 'texto' AS semanal;
SELECT jsonb_pretty(panel_semanal(0) - 'por_dia' - 'tendencia') AS panel;
SELECT jsonb_array_length(panel_semanal(0) -> 'por_dia') = 7 AS siete_dias,
       jsonb_array_length(panel_semanal(0) -> 'tendencia') = 8 AS ocho_semanas;
SELECT accion_panel('{"accion":"reprogramar","codigo":"T2","valor":"mañana"}') ->> 'texto' AS panel_accion;
SELECT comando_telegram('/ayuda') ->> 'texto' AS ayuda;
\echo '✔ escenario completo sin errores'
