// Nodo "Una sola vez": se ejecuta después de que todas las ramas del Switch terminaron
// (orden de ejecución v1: rama superior completa antes que la inferior).
const p = $input.first().json;
return [{ json: { ejecucion_id: $execution.id, chat_id: p.chat_id, resumen: p.resumen || null } }];
