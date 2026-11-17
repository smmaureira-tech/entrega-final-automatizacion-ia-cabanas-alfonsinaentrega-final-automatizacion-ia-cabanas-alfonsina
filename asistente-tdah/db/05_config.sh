#!/bin/sh
# Lo ejecuta PostgreSQL solo en el primer arranque (después de los .sql): aplica zona horaria y URL del panel.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v zona="${ZONA_HORARIA:-America/Santiago}" -v panel="${PANEL_URL:-http://localhost:8080}" <<'SQL'
UPDATE config SET valor = :'zona' WHERE clave = 'zona_horaria';
UPDATE config SET valor = :'panel' WHERE clave = 'panel_url';
SQL
