#!/bin/sh
# Prepara n8n: crea/actualiza las credenciales desde el .env y, la primera vez, importa y activa los workflows.
set -e
MARCA=/home/node/.n8n/.asistente-workflows-importados
CRED=/tmp/credenciales.json

# La credencial de Google solo se crea si todavía no existe, para no borrar la sesión ya conectada.
GCAL_EXISTE=no
if n8n export:credentials --id=asistGCal0000001 --output=/tmp/gcal.json >/dev/null 2>&1; then GCAL_EXISTE=si; fi

GCAL_EXISTE=$GCAL_EXISTE node -e '
const e = process.env, c = [];
c.push({ id: "asistPostgres001", name: "Postgres Asistente", type: "postgres",
  data: { host: "postgres", port: 5432, database: "asistente", user: e.POSTGRES_USER || "asistente", password: e.POSTGRES_PASSWORD, ssl: "disable" } });
if (e.TELEGRAM_BOT_TOKEN) c.push({ id: "asistTelegram001", name: "Telegram Asistente", type: "telegramApi",
  data: { accessToken: e.TELEGRAM_BOT_TOKEN } });
if (e.GCAL_EXISTE !== "si" && e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET) c.push({ id: "asistGCal0000001",
  name: "Google Calendar Asistente", type: "googleCalendarOAuth2Api",
  data: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET } });
require("fs").writeFileSync("/tmp/credenciales.json", JSON.stringify(c));
'
n8n import:credentials --input="$CRED"
: > "$CRED"   # vacía el archivo temporal con claves

if [ ! -f "$MARCA" ] || [ "$REIMPORTAR_WORKFLOWS" = "true" ]; then
  n8n import:workflow --separate --input=/workflows
  n8n update:workflow --id=asistTdahProgram --active=true
  n8n update:workflow --id=asistTdahPanel01 --active=true
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$NGROK_DOMAIN" ]; then
    n8n update:workflow --id=asistTdahEntrada --active=true
  else
    echo "Aviso: falta TELEGRAM_BOT_TOKEN o NGROK_DOMAIN; el workflow de entrada queda inactivo."
  fi
  touch "$MARCA"
fi
echo "n8n listo"
