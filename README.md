# Mis Pagos

> Este repositorio también contiene **[Asistente TDAH](asistente-tdah/README.md)**: captura por audio en Telegram, clasificación con Ollama local en seis categorías, recordatorios, Google Calendar y panel semanal (n8n).

App web para el celular que sirve para registrar y controlar pagos mensuales en cuotas.

## Qué hace

- **Obligaciones:** nombre, monto por cuota, número de cuotas, fecha del primer vencimiento, periodicidad mensual y días de aviso.
- **Pagos:** se registran por número de cuota ("cuota 3 de 10"), con monto y fecha. También acepta abonos extraordinarios, que cubren las últimas cuotas primero.
- **Progreso por obligación:** cuotas pagadas del total, porcentaje completado y monto restante.
- **Estados:** pagado, pendiente y vencido.
- **Inicio:** resumen del mes (total a pagar, pagado y pendiente), avisos de vencimientos y lista de próximos pagos ordenada por fecha.
- **Gestión:** editar, pausar o eliminar obligaciones. Al eliminar una obligación, su historial de pagos se conserva y se puede restaurar.
- **Recordatorios:** avisos X días antes en la pantalla de Inicio. En Android también llegan como notificaciones con la app instalada.
- **PIN de acceso:** opcional.
- **Respaldo:** exportar e importar en formato JSON, para pasar los datos entre el celular y la laptop.

## Datos y privacidad

Los datos se guardan solo en el dispositivo, en el almacenamiento del navegador (IndexedDB). No hay servidor ni cuentas. Conviene exportar un respaldo de vez en cuando.

## Publicarla (GitHub Pages)

1. En GitHub, ve a **Settings → Pages**.
2. En **Source**, elige *Deploy from a branch*. Selecciona la rama y la carpeta `/ (root)`.
3. Abre la dirección que te entrega GitHub (`https://<usuario>.github.io/<repo>/`):
   - **En Android (Chrome):** menú ⋮ → **Instalar app**. Después, en Ajustes → *Activar notificaciones*.
   - **En la laptop:** abre la misma dirección y, en Ajustes, **importa** el respaldo exportado desde el celular.

## Archivos

| Archivo | Uso |
| --- | --- |
| `index.html` | Estructura y estilos |
| `app.js` | Pantallas, formularios, respaldo, PIN y notificaciones |
| `core.js` | Cálculos de cuotas, estados y resúmenes (lo comparte el service worker) |
| `sw.js` | Funcionamiento sin conexión y recordatorios en segundo plano |
| `manifest.webmanifest`, `icon*` | Instalación como app |
| `tools/make-icons.js` | Regenera los íconos PNG (`node tools/make-icons.js`) |

Para probarla en local: `python3 -m http.server` y abre `http://localhost:8000`.
