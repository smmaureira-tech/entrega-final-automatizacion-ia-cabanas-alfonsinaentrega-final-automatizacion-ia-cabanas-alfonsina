-- =====================================================================
-- Asistente TDAH · Esquema de base de datos (PostgreSQL 14+)
-- Seis destinos (tareas, recordatorios, eventos, ideas, conocimientos,
-- otros) + bandeja de revisión. Todos los registros guardan la captura
-- (audio/mensaje) de la que salieron, así se mantiene la relación.
-- =====================================================================

CREATE TABLE IF NOT EXISTS config (
  clave text PRIMARY KEY,
  valor text NOT NULL
);
INSERT INTO config VALUES
  ('zona_horaria', 'America/Santiago'),
  ('panel_url', 'http://localhost:8080')
ON CONFLICT (clave) DO NOTHING;

-- Cada audio o mensaje recibido. La transcripción original nunca se modifica.
CREATE TABLE IF NOT EXISTS capturas (
  id                      serial PRIMARY KEY,
  ejecucion_id            text,
  origen                  text NOT NULL DEFAULT 'texto' CHECK (origen IN ('voz', 'texto', 'aclaracion')),
  transcripcion_original  text NOT NULL,
  transcripcion_corregida text,
  resumen_general         text,
  json_clasificador       jsonb,
  errores_validacion      jsonb,
  creado_en               timestamptz NOT NULL DEFAULT now()
);

-- CATEGORÍA 1 · Bandeja de tareas
CREATE TABLE IF NOT EXISTS tareas (
  id               serial PRIMARY KEY,
  captura_id       int REFERENCES capturas(id) ON DELETE SET NULL,
  ejecucion_id     text,
  id_local         text,
  relacionado_ref  text,
  titulo           text NOT NULL,
  descripcion      text,
  fecha_captura    timestamptz NOT NULL DEFAULT now(),
  fecha_limite     date,
  prioridad        text CHECK (prioridad IN ('alta', 'media', 'baja')),
  estado           text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'en curso', 'completada')),
  proyecto         text,
  etiquetas        text[] NOT NULL DEFAULT '{}',
  idea_id          int,
  reprogramaciones int NOT NULL DEFAULT 0,
  completada_en    timestamptz,
  actualizado_en   timestamptz NOT NULL DEFAULT now()
);

-- CATEGORÍA 2 · Recordatorios (los envía el workflow programado de n8n)
CREATE TABLE IF NOT EXISTS recordatorios (
  id               serial PRIMARY KEY,
  captura_id       int REFERENCES capturas(id) ON DELETE SET NULL,
  ejecucion_id     text,
  id_local         text,
  relacionado_ref  text,
  mensaje          text NOT NULL,
  fecha            date NOT NULL,
  hora             time NOT NULL,
  programado_para  timestamptz NOT NULL,
  estado           text NOT NULL DEFAULT 'programado'
                   CHECK (estado IN ('programado', 'enviando', 'enviado', 'confirmado', 'cancelado')),
  creado_en        timestamptz NOT NULL DEFAULT now(),
  enviado_en       timestamptz,
  insistencias     int NOT NULL DEFAULT 0,
  telegram_msg_id  bigint,
  confirmado_en    timestamptz            -- confirmación de ejecución (botón "Hecho")
);

-- CATEGORÍA 3 · Eventos y compromisos (copia local de lo enviado a Google Calendar)
CREATE TABLE IF NOT EXISTS eventos (
  id               serial PRIMARY KEY,
  captura_id       int REFERENCES capturas(id) ON DELETE SET NULL,
  ejecucion_id     text,
  id_local         text,
  relacionado_ref  text,
  nombre           text NOT NULL,
  descripcion      text,
  fecha            date NOT NULL,
  hora_inicio      time,
  hora_termino     time,
  lugar            text,
  participantes    text[] NOT NULL DEFAULT '{}',
  etiquetas        text[] NOT NULL DEFAULT '{}',
  google_event_id  text,
  google_link      text,
  calendar_error   text,
  estado           text NOT NULL DEFAULT 'agendado' CHECK (estado IN ('agendado', 'realizado', 'no realizado', 'cancelado')),
  creado_en        timestamptz NOT NULL DEFAULT now()
);

-- CATEGORÍA 4 · Biblioteca de ideas
CREATE TABLE IF NOT EXISTS ideas (
  id                   serial PRIMARY KEY,
  captura_id           int REFERENCES capturas(id) ON DELETE SET NULL,
  ejecucion_id         text,
  id_local             text,
  relacionado_ref      text,
  titulo               text NOT NULL,
  descripcion          text NOT NULL,
  fecha_captura        timestamptz NOT NULL DEFAULT now(),
  area_tematica        text,
  proyecto             text,
  potencial_aplicacion text,
  etiquetas            text[] NOT NULL DEFAULT '{}',
  estado               text NOT NULL DEFAULT 'nueva' CHECK (estado IN ('nueva', 'en exploración', 'en desarrollo', 'descartada'))
);

-- CATEGORÍA 5 · Biblioteca de conocimientos (con búsqueda de texto completo)
CREATE TABLE IF NOT EXISTS conocimientos (
  id                  serial PRIMARY KEY,
  captura_id          int REFERENCES capturas(id) ON DELETE SET NULL,
  ejecucion_id        text,
  id_local            text,
  relacionado_ref     text,
  titulo              text NOT NULL,
  concepto_principal  text,
  explicacion         text NOT NULL,
  fecha_captura       timestamptz NOT NULL DEFAULT now(),
  fuente              text,
  area_tematica       text,
  aplicaciones        text,
  etiquetas           text[] NOT NULL DEFAULT '{}',
  busqueda            tsvector GENERATED ALWAYS AS (
    to_tsvector('spanish', coalesce(titulo, '') || ' ' || coalesce(concepto_principal, '') || ' ' ||
                coalesce(explicacion, '') || ' ' || coalesce(area_tematica, '') || ' ' || coalesce(fuente, ''))
  ) STORED
);
CREATE INDEX IF NOT EXISTS conocimientos_busqueda_idx ON conocimientos USING gin (busqueda);

-- CATEGORÍA 6 · Archivo general
CREATE TABLE IF NOT EXISTS otros (
  id               serial PRIMARY KEY,
  captura_id       int REFERENCES capturas(id) ON DELETE SET NULL,
  ejecucion_id     text,
  id_local         text,
  relacionado_ref  text,
  titulo           text NOT NULL,
  transcripcion    text,
  resumen          text,
  fecha            timestamptz NOT NULL DEFAULT now(),
  tema             text,
  etiquetas        text[] NOT NULL DEFAULT '{}'
);

-- Bandeja de revisión: lo dudoso o incompleto espera aquí hasta que se aclare.
CREATE TABLE IF NOT EXISTS revision (
  id                 serial PRIMARY KEY,
  captura_id         int REFERENCES capturas(id) ON DELETE SET NULL,
  ejecucion_id       text,
  id_local           text,
  relacionado_ref    text,
  categoria_sugerida text,
  titulo             text,
  registro           jsonb NOT NULL,
  tipo               text NOT NULL DEFAULT 'categoria' CHECK (tipo IN ('categoria', 'aclaracion')),
  motivo             text,
  pregunta           text,
  telegram_msg_id    bigint,
  estado             text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'resuelta')),
  resuelto_en        timestamptz,
  creado_en          timestamptz NOT NULL DEFAULT now()
);

-- Relación explícita entre registros (p. ej. una tarea que nace de una idea).
CREATE TABLE IF NOT EXISTS vinculos (
  origen  text NOT NULL,
  destino text NOT NULL,
  PRIMARY KEY (origen, destino)
);

-- Historial de cambios manuales de categoría (nada se pierde al reclasificar).
CREATE TABLE IF NOT EXISTS reclasificaciones (
  id                serial PRIMARY KEY,
  codigo_anterior   text NOT NULL,
  categoria_destino text NOT NULL,
  datos             jsonb NOT NULL,
  creado_en         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tareas_estado_idx ON tareas (estado, fecha_limite);
CREATE INDEX IF NOT EXISTS recordatorios_cola_idx ON recordatorios (estado, programado_para);
CREATE INDEX IF NOT EXISTS eventos_fecha_idx ON eventos (fecha);
CREATE INDEX IF NOT EXISTS revision_msg_idx ON revision (telegram_msg_id);

-- Vista unificada: permite confirmar, buscar y relacionar registros de todas las categorías.
CREATE OR REPLACE VIEW v_registros AS
  SELECT 'T' || id AS codigo, 'tarea' AS categoria, id, captura_id, ejecucion_id, id_local, relacionado_ref,
         titulo, descripcion AS texto, fecha_captura AS creado_en, 'Bandeja de tareas' AS destino FROM tareas
  UNION ALL
  SELECT 'R' || id, 'recordatorio', id, captura_id, ejecucion_id, id_local, relacionado_ref,
         mensaje, mensaje, creado_en, 'Notificaciones de Telegram' FROM recordatorios
  UNION ALL
  SELECT 'E' || id, 'evento', id, captura_id, ejecucion_id, id_local, relacionado_ref,
         nombre, descripcion, creado_en, 'Google Calendar' FROM eventos
  UNION ALL
  SELECT 'I' || id, 'idea', id, captura_id, ejecucion_id, id_local, relacionado_ref,
         titulo, descripcion, fecha_captura, 'Biblioteca de ideas' FROM ideas
  UNION ALL
  SELECT 'C' || id, 'conocimiento', id, captura_id, ejecucion_id, id_local, relacionado_ref,
         titulo, coalesce(concepto_principal, '') || ' ' || explicacion, fecha_captura, 'Biblioteca de conocimientos' FROM conocimientos
  UNION ALL
  SELECT 'O' || id, 'otros', id, captura_id, ejecucion_id, id_local, relacionado_ref,
         titulo, coalesce(resumen, '') || ' ' || coalesce(transcripcion, ''), fecha, 'Archivo general' FROM otros
  UNION ALL
  SELECT 'V' || id, 'revision', id, captura_id, ejecucion_id, id_local, relacionado_ref,
         titulo, coalesce(registro->>'contenido', ''), creado_en, 'Bandeja de revisión' FROM revision WHERE estado = 'pendiente';
