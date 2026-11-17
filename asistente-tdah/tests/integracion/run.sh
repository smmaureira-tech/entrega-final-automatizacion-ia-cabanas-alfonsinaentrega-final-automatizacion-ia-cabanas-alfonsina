#!/usr/bin/env bash
# Prueba de integración: n8n real + PostgreSQL real + servidor falso de Telegram/Whisper/Ollama.
# Requisitos: PostgreSQL accesible (PGHOST/PGPORT/PGUSER/PGPASSWORD) y n8n instalado (N8N_BIN).
# Ej.: PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres N8N_BIN=$(which n8n) tests/integracion/run.sh
set -euo pipefail
cd "$(dirname "$0")"
RAIZ=$(cd ../.. && pwd)
N8N_BIN=${N8N_BIN:-n8n}
TMP=$(mktemp -d)
DB=asistente_it_$$
export N8N_USER_FOLDER=$TMP/n8n N8N_ENCRYPTION_KEY=clave-de-prueba N8N_PORT=5699 N8N_DIAGNOSTICS_ENABLED=false \
  N8N_BLOCK_ENV_ACCESS_IN_NODE=false N8N_RUNNERS_ENABLED=false N8N_SECURE_COOKIE=false GENERIC_TIMEZONE=America/Santiago \
  TELEGRAM_API_URL=http://127.0.0.1:8999 TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_CHAT_ID=42 \
  OLLAMA_URL=http://127.0.0.1:8999 WHISPER_URL=http://127.0.0.1:8999 OLLAMA_MODEL=modelo-falso PANEL_TOKEN=token-prueba \
  N8N_LOG_LEVEL=warn DB_SQLITE_POOL_SIZE=1 N8N_LISTEN_ADDRESS=127.0.0.1 N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=false
mkdir -p "$N8N_USER_FOLDER"
limpiar() {
  rc=$?
  if [ "$rc" != 0 ] || [ "${FALLOS:-0}" != 0 ]; then echo "--- n8n.log"; tail -40 "$TMP/n8n.log"; echo "--- última respuesta"; head -c 1500 "$TMP/ultima.json" 2>/dev/null; echo; fi
  kill ${PID_N8N:-} ${PID_MOCK:-} 2>/dev/null || true; dropdb --if-exists "$DB" 2>/dev/null || true
}
trap limpiar EXIT

createdb "$DB"
for f in "$RAIZ"/db/*.sql; do psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"; done
node mock.js > "$TMP/mock.log" 2>&1 & PID_MOCK=$!

cat > "$TMP/cred.json" <<JSON
[{"id":"asistPostgres001","name":"Postgres Asistente","type":"postgres",
  "data":{"host":"${PGHOST:-127.0.0.1}","port":${PGPORT:-5432},"database":"$DB","user":"${PGUSER:-postgres}","password":"${PGPASSWORD:-}","ssl":"disable"}}]
JSON
mkdir -p "$TMP/wf" && node preparar-variante.js "$TMP/wf"
"$N8N_BIN" import:credentials --input="$TMP/cred.json" > /dev/null
"$N8N_BIN" import:workflow --separate --input="$TMP/wf" > /dev/null
for id in asistTdahEntrada asistTdahPanel01 asistTdahProgram; do "$N8N_BIN" update:workflow --id=$id --active=true > /dev/null 2>&1; done
"$N8N_BIN" start > "$TMP/n8n.log" 2>&1 & PID_N8N=$!
for i in $(seq 1 90); do curl -sf http://127.0.0.1:5699/healthz > /dev/null && break; sleep 1; done
sleep 3

N=0; FALLOS=0
enviar() { curl -s -X POST -H 'content-type: application/json' -d "$1" http://127.0.0.1:5699/webhook/tg-test > "$TMP/ultima.json" || echo "(falló el POST al webhook)"; }
q() { psql -d "$DB" -Atc "$1"; }
afirmar() { N=$((N+1)); if [ "$2" = "$3" ]; then echo "✔ $1"; else echo "✘ $1 (esperado: $3, obtenido: $2)"; FALLOS=$((FALLOS+1)); fi; }
tg() { curl -s http://127.0.0.1:8999/_log | node -e "const l=JSON.parse(require('fs').readFileSync(0));$1"; }

echo "— 1. Audio con 4 categorías (idea + tarea relacionada + evento + recordatorio relativo)"
enviar '{"update_id":1,"message":{"message_id":1,"chat":{"id":42},"voice":{"file_id":"abc","duration":9}}}'
afirmar "Whisper recibió el audio como multipart" "$(tg "console.log(l.some(x=>x.api==='whisper'&&x.multipart))")" "true"
afirmar "Ollama recibió el esquema JSON" "$(tg "console.log(l.some(x=>x.api==='ollama'&&x.tiene_esquema))")" "true"
afirmar "Captura guardada con transcripción original" "$(q "select origen||':'||(transcripcion_original like 'eh se me ocurrió%') from capturas order by id limit 1")" "voz:true"
afirmar "Idea guardada" "$(q "select count(*) from ideas")" "1"
afirmar "Tarea guardada y relacionada a la idea" "$(q "select count(*) from tareas where idea_id is not null")" "1"
afirmar "Evento guardado (Calendar sin credencial → queda con error registrado)" "$(q "select count(*) from eventos where calendar_error is not null and google_event_id is null")" "1"
afirmar "Recordatorio programado a +60 min" "$(q "select count(*) from recordatorios where estado='programado' and abs(extract(epoch from programado_para - now()) - 3600) < 120")" "1"
afirmar "Todos los registros ligados a la misma captura" "$(q "select count(distinct captura_id) from v_registros")" "1"
afirmar "Se envió UNA confirmación" "$(tg "console.log(l.filter(x=>x.metodo==='sendMessage'&&/Guardé 4 registros/.test(x.datos.text)).length)")" "1"
afirmar "Se mostró 'escribiendo…'" "$(tg "console.log(l.some(x=>x.metodo==='sendChatAction'))")" "true"

echo "— 2. Recordatorio sin hora → revisión → respuesta del usuario"
enviar '{"update_id":2,"message":{"message_id":2,"chat":{"id":42},"text":"recuérdame llamar al dentista"}}'
afirmar "Fue a revisión (no se inventó la hora)" "$(q "select tipo||':'||estado from revision order by id desc limit 1")" "aclaracion:pendiente"
MSG=$(tg "const m=l.filter(x=>x.metodo==='sendMessage'&&x.datos.reply_markup&&x.datos.reply_markup.force_reply);console.log(m.length)")
afirmar "La pregunta pide responder al mensaje (force_reply)" "$MSG" "1"
PREG=$(q "select telegram_msg_id from revision order by id desc limit 1")
afirmar "Se guardó el id del mensaje de la pregunta" "$([ -n "$PREG" ] && echo si)" "si"
enviar "{\"update_id\":3,\"message\":{\"message_id\":3,\"chat\":{\"id\":42},\"text\":\"mañana a las 10\",\"reply_to_message\":{\"message_id\":$PREG}}}"
afirmar "La revisión quedó resuelta" "$(q "select estado from revision order by id desc limit 1")" "resuelta"
afirmar "Recordatorio creado para mañana 10:00" "$(q "select count(*) from recordatorios where hora='10:00' and fecha=hoy()+1")" "1"
afirmar "Captura de aclaración registrada" "$(q "select count(*) from capturas where origen='aclaracion'")" "1"

echo "— 3. JSON inválido del modelo → nada se pierde"
enviar '{"update_id":4,"message":{"message_id":4,"chat":{"id":42},"text":"basura"}}'
afirmar "Va a revisión con botones de categoría" "$(q "select tipo from revision order by id desc limit 1")" "categoria"
V=$(q "select 'V'||id from revision order by id desc limit 1")

echo "— 4. Botón de categoría (reclasificación manual desde Telegram)"
enviar "{\"update_id\":5,\"callback_query\":{\"id\":\"cb1\",\"data\":\"cat:$V:idea\",\"message\":{\"message_id\":9,\"chat\":{\"id\":42}}}}"
afirmar "Respondió el botón (answerCallbackQuery)" "$(tg "console.log(l.some(x=>x.metodo==='answerCallbackQuery'))")" "true"
afirmar "Ahora hay 2 ideas" "$(q "select count(*) from ideas")" "2"

echo "— 5. Comandos"
enviar '{"update_id":6,"message":{"message_id":6,"chat":{"id":42},"text":"/tareas"}}'
afirmar "/tareas responde con la lista" "$(tg "const m=l.filter(x=>x.metodo==='sendMessage').pop();console.log(/Tareas pendientes/.test(m.datos.text)&&!!m.datos.reply_markup)")" "true"
T=$(q "select 'T'||id from tareas limit 1")
enviar "{\"update_id\":7,\"message\":{\"message_id\":7,\"chat\":{\"id\":42},\"text\":\"/hecho $T\"}}"
afirmar "/hecho completa la tarea" "$(q "select estado from tareas limit 1")" "completada"
I=$(q "select 'I'||min(id) from ideas")
enviar "{\"update_id\":8,\"message\":{\"message_id\":8,\"chat\":{\"id\":42},\"text\":\"/mover $I tarea\"}}"
afirmar "/mover pasa la idea a tareas (vuelve a pasar por el Switch)" "$(q "select count(*) from tareas")" "2"
afirmar "Quedó registro del cambio" "$(q "select count(*) from reclasificaciones")" "2"

echo "— 6. Chat desconocido es ignorado"
ANTES=$(tg "console.log(l.length)")
enviar '{"update_id":9,"message":{"message_id":1,"chat":{"id":999},"text":"hola"}}'
afirmar "No se responde a desconocidos" "$(tg "console.log(l.length)")" "$ANTES"

echo "— 7. API del panel"
afirmar "Sin token → 401" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5699/webhook/panel)" "401"
afirmar "Con token devuelve 7 días" "$(curl -s -H 'X-Panel-Token: token-prueba' 'http://127.0.0.1:5699/webhook/panel?semana=0' | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).por_dia.length)")" "7"
T2=$(q "select 'T'||max(id) from tareas")
curl -s -X POST -H 'X-Panel-Token: token-prueba' -H 'content-type: application/json' -d "{\"accion\":\"reprogramar\",\"codigo\":\"$T2\",\"valor\":\"viernes\"}" http://127.0.0.1:5699/webhook/panel-accion > /dev/null
afirmar "Reprogramar desde el panel" "$(q "select extract(dow from fecha_limite) from tareas where 'T'||id='$T2'")" "5"

echo "— 8. Recordatorios programados (workflow 2, corre cada minuto)"
q "update recordatorios set programado_para = now() - interval '1 minute' where hora = '10:00'" > /dev/null
for i in $(seq 1 30); do [ "$(q "select estado from recordatorios where hora='10:00'")" = "enviado" ] && break; sleep 3; done
afirmar "El recordatorio vencido se envió y quedó 'enviado'" "$(q "select estado from recordatorios where hora='10:00'")" "enviado"
afirmar "Llegó a Telegram con botones Hecho / +1 h / Mañana" "$(tg "const m=l.filter(x=>x.metodo==='sendMessage'&&/Recordatorio R/.test(x.datos.text)).pop();console.log(m?m.datos.reply_markup.inline_keyboard[0].length:0)")" "3"
afirmar "Se guardó el id del mensaje enviado" "$(q "select telegram_msg_id is not null from recordatorios where hora='10:00'")" "t"
sleep 65
afirmar "No se duplica en el minuto siguiente" "$(tg "console.log(l.filter(x=>x.metodo==='sendMessage'&&/Recordatorio R/.test(x.datos.text)).length)")" "1"
tg "const m=l.filter(x=>x.metodo==='sendMessage'&&/Guardé/.test(x.datos.text));console.log('\n--- Ejemplo de confirmación enviada a Telegram:\n'+m[0].datos.text)"

if [ "$FALLOS" -gt 0 ]; then
  echo; echo "Errores de n8n:"; grep -iE "error|problem" "$TMP/n8n.log" | head -20
  echo "$FALLOS de $N pruebas fallaron"; exit 1
fi
echo; echo "✔ $N pruebas de integración OK"
