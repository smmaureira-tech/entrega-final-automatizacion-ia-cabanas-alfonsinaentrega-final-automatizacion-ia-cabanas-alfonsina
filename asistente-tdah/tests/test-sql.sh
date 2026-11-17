#!/usr/bin/env bash
# Crea una base temporal, carga el esquema y corre el escenario de prueba.
# Variables: PGHOST, PGPORT, PGUSER (las de psql). Ej.: PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres tests/test-sql.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=asistente_test_$$
createdb "$DB"
trap 'dropdb --if-exists "$DB"' EXIT
for f in db/*.sql; do psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"; done
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f tests/escenario.sql
