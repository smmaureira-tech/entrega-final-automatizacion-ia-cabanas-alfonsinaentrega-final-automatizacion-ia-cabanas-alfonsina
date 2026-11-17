// Crea una copia del workflow 1 donde el Telegram Trigger se reemplaza por un Webhook,
// para poder enviarle "updates" de Telegram simulados. Uso: node preparar-variante.js <dir_salida>
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
const src = p => JSON.parse(fs.readFileSync(path.join(__dirname, '../../n8n', p), 'utf8'));
const w1 = src('1-entrada-telegram.json');
const t = w1.nodes.find(n => n.name === 'Telegram Trigger');
Object.assign(t, { type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: { httpMethod: 'POST', path: 'tg-test', responseMode: 'lastNode', options: {} } });
delete t.credentials;
const e = w1.nodes.find(n => n.name === 'Clasificar entrada');
e.parameters.jsCode = e.parameters.jsCode.replace('const u = $input.first().json;', 'const u = $input.first().json.body;');
fs.writeFileSync(path.join(out, 'w1.json'), JSON.stringify(w1));
fs.writeFileSync(path.join(out, 'w2.json'), JSON.stringify(src('2-recordatorios-y-resumenes.json')));
fs.writeFileSync(path.join(out, 'w3.json'), JSON.stringify(src('3-api-panel.json')));
