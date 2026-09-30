(() => {
  'use strict';
  const C = window.PagosCore;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const CURRENCIES = [['CLP', 'Peso chileno'], ['ARS', 'Peso argentino'], ['MXN', 'Peso mexicano'], ['COP', 'Peso colombiano'], ['PEN', 'Sol peruano'], ['UYU', 'Peso uruguayo'], ['USD', 'Dólar'], ['EUR', 'Euro']];
  const STATUS_LABEL = { pagado: 'Pagado', pendiente: 'Pendiente', vencido: 'Vencido', pausada: 'Pausada', archivada: 'Eliminada' };

  const DEFAULT = () => ({
    version: 1, obligations: [], payments: [],
    settings: { currency: 'CLP', notify: false, pinHash: null, pinSalt: null, lastExport: null }
  });
  let state = DEFAULT();
  let storageMode = 'idb';

  // ---------- Almacenamiento ----------
  function normalize(s) {
    const d = DEFAULT();
    return {
      ...d, ...s,
      settings: { ...d.settings, ...(s.settings || {}) },
      obligations: Array.isArray(s.obligations) ? s.obligations : [],
      payments: Array.isArray(s.payments) ? s.payments : []
    };
  }

  async function load() {
    try {
      const s = await C.idbGet('state');
      if (s) state = normalize(s);
      return;
    } catch (e) { storageMode = 'local'; }
    try {
      const raw = localStorage.getItem('mis-pagos-state');
      if (raw) state = normalize(JSON.parse(raw));
    } catch (e) { storageMode = 'memory'; }
  }

  async function save() {
    if (storageMode === 'idb') {
      try { await C.idbSet('state', state); return; } catch (e) { storageMode = 'local'; }
    }
    if (storageMode === 'local') {
      try { localStorage.setItem('mis-pagos-state', JSON.stringify(state)); return; } catch (e) { storageMode = 'memory'; }
    }
    toast('No se pudo guardar en este navegador');
  }

  // ---------- Formato ----------
  const money = v => C.money(v, state.settings.currency);
  function fmtDate(s) { const { y, m, d } = C.parse(s); return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`; }
  function fmtShort(s) { const { m, d } = C.parse(s); return `${d} ${MONTHS[m - 1].slice(0, 3)}`; }
  function rel(days) {
    if (days === 0) return 'Hoy';
    if (days === 1) return 'Mañana';
    if (days === -1) return 'Ayer';
    if (days > 1) return `En ${days} días`;
    return `Hace ${-days} días`;
  }
  const pct = x => Math.round(Math.max(0, Math.min(1, x)) * 100);

  // Acepta "120.000", "120000", "1.234,50" o "99.90".
  function parseAmount(raw) {
    let s = String(raw || '').replace(/[^\d.,-]/g, '');
    if (!s) return NaN;
    if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (s.includes(',')) s = s.replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  }
  const amountInput = v => (v === undefined || v === null || v === '' || Number.isNaN(v)) ? '' : new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 }).format(v);

  // ---------- Navegación ----------
  let tab = 'home';
  let detailId = null;
  let listFilter = 'active';
  let homeMonth = C.todayStr().slice(0, 7);
  let ignorePop = false;
  let sheetPushed = false;

  function go(newTab) {
    if (detailId) { detailId = null; if (history.state && history.state.detail) { ignorePop = true; history.back(); } }
    tab = newTab;
    render();
    window.scrollTo(0, 0);
  }
  function openDetail(id) {
    detailId = id;
    history.pushState({ detail: true }, '');
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener('popstate', () => {
    if (ignorePop) { ignorePop = false; return; }
    if (sheet.open) { sheetPushed = false; sheet.close(); return; }
    if (detailId) { detailId = null; render(); }
  });

  // ---------- Render ----------
  const view = $('#view');

  function render() {
    document.querySelectorAll('.tabs button').forEach(b => {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const ob = detailId && state.obligations.find(o => o.id === detailId);
    if (detailId && !ob) detailId = null;
    view.innerHTML = ob ? viewDetail(ob) : tab === 'list' ? viewList() : tab === 'settings' ? viewSettings() : viewHome();
  }

  function emptyState() {
    return `<div class="card empty">
      <svg class="ring" viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="28" fill="none" stroke="var(--track)" stroke-width="8"/><path d="M36 8a28 28 0 0 1 28 28" fill="none" stroke="var(--accent)" stroke-width="8" stroke-linecap="round"/></svg>
      <h2>Empieza con tu primer pago</h2>
      <p class="muted">Agrega un crédito, arriendo o suscripción con sus cuotas y te mostraremos cuánto llevas y qué viene.</p>
      <button class="btn primary block" data-action="new-ob">Crear obligación</button>
    </div>`;
  }

  function viewHome() {
    if (!state.obligations.length) return `<h1>Mis Pagos</h1>${emptyState()}`;
    const today = C.todayStr();
    const [y, m] = homeMonth.split('-').map(Number);
    const sum = C.monthSummary(state, homeMonth, today);
    const up = C.upcoming(state, today);
    const overdue = up.filter(u => u.c.status === 'vencido');
    const soon = up.filter(u => u.c.status === 'pendiente' && u.days <= (u.o.reminderDays ?? 3));
    const isCurrent = homeMonth === today.slice(0, 7);

    let html = `<div class="month">
      <button class="icon-btn" data-action="month" data-d="-1" aria-label="Mes anterior">‹</button>
      <h1>${MONTHS[m - 1]} ${y}</h1>
      <button class="icon-btn" data-action="month" data-d="1" aria-label="Mes siguiente">›</button>
    </div>
    <section class="card summary" aria-label="Resumen del mes">
      <p class="label">Pendiente del mes</p>
      <p class="big">${money(sum.pending)}</p>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${sum.toPay ? pct(sum.paid / sum.toPay) : 0}"><span style="width:${sum.toPay ? pct(sum.paid / sum.toPay) : 0}%"></span></div>
      <div class="split">
        <div><span class="label">Total a pagar</span><span class="mid">${money(sum.toPay)}</span></div>
        <div><span class="label">Pagado</span><span class="mid" style="color:var(--ok)">${money(sum.paid)}</span></div>
      </div>
      <p class="small muted">${sum.count ? `${sum.paidCount} de ${sum.count} cuotas del mes pagadas` : 'No hay cuotas este mes'}${sum.extras ? ` · Abonos extra: ${money(sum.extras)}` : ''}</p>
      ${isCurrent ? '' : '<button class="btn small" data-action="month-today">Volver al mes actual</button>'}
    </section>`;

    if (overdue.length) {
      const tot = overdue.reduce((s, u) => s + u.c.pending, 0);
      html += `<button class="alert bad" data-action="pay" data-id="${overdue[0].o.id}" data-n="${overdue[0].c.n}">
        <span class="grow">${overdue.length === 1 ? '1 cuota vencida' : `${overdue.length} cuotas vencidas`} · ${money(tot)}</span><span aria-hidden="true">›</span></button>`;
    }
    for (const u of soon) {
      html += `<button class="alert warn" data-action="pay" data-id="${u.o.id}" data-n="${u.c.n}">
        <span class="grow">${esc(u.o.name)} ${C.dueLabel(u.days)} · ${money(u.c.pending)}</span><span aria-hidden="true">›</span></button>`;
    }

    html += `<div class="section-head"><h2>Próximos pagos</h2></div>`;
    if (up.length) {
      html += `<ul class="list">${up.map(u => `<li><button class="item" data-action="pay" data-id="${u.o.id}" data-n="${u.c.n}">
          <span class="dot st-${u.c.status}" aria-hidden="true"></span>
          <span class="grow"><span class="name">${esc(u.o.name)}</span><span class="sub">Cuota ${u.c.n} de ${u.o.total} · ${fmtShort(u.c.due)}</span></span>
          <span class="right"><span class="amt">${money(u.c.pending)}</span><span class="chip st-${u.c.status}">${u.c.status === 'vencido' ? 'Vencido' : rel(u.days)}</span></span>
        </button></li>`).join('')}</ul>`;
    } else {
      html += `<p class="card muted">No tienes pagos pendientes. Todo al día.</p>`;
    }
    html += `<button class="btn primary block" data-action="pay">Registrar pago</button>`;
    return html;
  }

  function obCard(o) {
    const info = C.computeObligation(o, state.payments, C.todayStr());
    const next = info.next;
    return `<li><button class="card ob" data-action="detail" data-id="${o.id}">
      <span class="ob-top"><span class="name">${esc(o.name)}</span><span class="chip st-${info.status}">${STATUS_LABEL[info.status]}</span></span>
      <span class="bar thin st-${info.status}"><span style="width:${pct(info.percent)}%"></span></span>
      <span class="ob-meta"><span><b class="num">${info.paidCount}</b> de ${o.total} cuotas · ${pct(info.percent)}%</span><span>Restan <b class="num">${money(info.remaining)}</b></span></span>
      ${next && o.state === 'active' ? `<span class="small muted">Próxima: cuota ${next.n} · ${fmtDate(next.due)} · ${money(next.pending)}</span>` : ''}
    </button></li>`;
  }

  function viewList() {
    const groups = { active: [], paused: [], archived: [] };
    for (const o of state.obligations) (groups[o.state] || groups.active).push(o);
    const items = groups[listFilter];
    const names = { active: 'Activas', paused: 'Pausadas', archived: 'Eliminadas' };
    const empty = { active: 'No tienes obligaciones activas.', paused: 'No tienes obligaciones pausadas.', archived: 'Aquí quedan las obligaciones que elimines, con su historial de pagos.' };
    return `<div class="section-head"><h1>Obligaciones</h1><button class="btn small primary" data-action="new-ob">+ Nueva</button></div>
      <div class="seg" role="tablist">${Object.keys(names).map(k => `<button role="tab" aria-selected="${k === listFilter}" class="${k === listFilter ? 'on' : ''}" data-action="filter" data-f="${k}">${names[k]} (${groups[k].length})</button>`).join('')}</div>
      ${items.length ? `<ul class="list">${items.map(obCard).join('')}</ul>` : (state.obligations.length ? `<p class="card muted">${empty[listFilter]}</p>` : emptyState())}`;
  }

  function viewDetail(o) {
    const info = C.computeObligation(o, state.payments, C.todayStr());
    const today = C.todayStr();
    const pays = info.payments.slice().sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
    let actions;
    if (o.state === 'archived') {
      actions = `<div class="btn-row"><button class="btn" data-action="restore" data-id="${o.id}">Restaurar</button><button class="btn danger" data-action="purge" data-id="${o.id}">Borrar para siempre</button></div>`;
    } else {
      actions = `${info.complete ? '' : `<div class="btn-row"><button class="btn primary" data-action="pay" data-id="${o.id}">Registrar pago</button><button class="btn" data-action="extra" data-id="${o.id}">Abono extra</button></div>`}
        <div class="btn-row three"><button class="btn small" data-action="edit" data-id="${o.id}">Editar</button><button class="btn small" data-action="toggle-pause" data-id="${o.id}">${o.state === 'paused' ? 'Reanudar' : 'Pausar'}</button><button class="btn small danger" data-action="archive" data-id="${o.id}">Eliminar</button></div>`;
    }
    const canPay = o.state !== 'archived';
    return `<button class="back" data-action="back">‹ Volver</button>
      <div class="ob-top"><h1>${esc(o.name)}</h1><span class="chip st-${info.status}">${STATUS_LABEL[info.status]}</span></div>
      <section class="card summary">
        <p class="label">Progreso</p>
        <p class="big">${info.paidCount} <span class="muted" style="font-size:1.3rem;font-weight:600">de ${o.total} cuotas</span></p>
        <div class="bar st-${info.status}"><span style="width:${pct(info.percent)}%"></span></div>
        <p class="small muted">${pct(info.percent)}% completado</p>
        <div class="facts">
          <div><span class="label">Pagado</span><span class="v" style="color:var(--ok)">${money(info.paidTotal)}</span></div>
          <div><span class="label">Restante</span><span class="v">${money(info.remaining)}</span></div>
          <div><span class="label">Cuota mensual</span><span class="v">${money(o.amount)}</span></div>
          <div><span class="label">Total</span><span class="v">${money(info.totalAmount)}</span></div>
          <div><span class="label">Vencimiento</span><span class="v">Día ${C.parse(o.firstDue).d} de cada mes</span></div>
          <div><span class="label">Recordatorio</span><span class="v">${o.reminderDays ? `${o.reminderDays} ${o.reminderDays === 1 ? 'día' : 'días'} antes` : 'El mismo día'}</span></div>
        </div>
        ${o.state === 'paused' ? '<p class="alert info">Pausada: no aparece en el resumen ni en próximos pagos.</p>' : ''}
        ${o.state === 'archived' ? '<p class="alert info">Eliminada: ya no se considera vigente, pero su historial se conserva.</p>' : ''}
      </section>
      ${actions}
      <details ${o.total <= 12 ? 'open' : ''}>
        <summary>Cuotas (${o.total})</summary>
        <ul class="rows">${info.cuotas.map(c => `<li><button class="row" ${c.status !== 'pagado' && canPay ? `data-action="pay" data-id="${o.id}" data-n="${c.n}"` : 'disabled'}>
          <span class="dot st-${c.status}" aria-hidden="true"></span>
          <span class="grow"><span>Cuota ${c.n}</span><span class="sub">${fmtDate(c.due)}${c.status === 'vencido' ? ` · hace ${-C.daysBetween(today, c.due)} días` : ''}${c.extra > 0.005 && c.status === 'pagado' && c.paid < 0.005 ? ' · cubierta con abono' : ''}${c.status !== 'pagado' && c.paid + c.extra > 0.005 ? ` · falta ${money(c.pending)}` : ''}</span></span>
          <span class="chip st-${c.status}">${STATUS_LABEL[c.status]}</span>
        </button></li>`).join('')}</ul>
      </details>
      <details open>
        <summary>Historial de pagos (${pays.length})</summary>
        ${pays.length ? `<ul class="rows">${pays.map(p => `<li><button class="row" data-action="edit-pay" data-pid="${p.id}">
          <span class="grow"><span>${p.type === 'extra' ? 'Abono extra' : `Cuota ${p.cuota} de ${o.total}`}</span><span class="sub">${fmtDate(p.date)}${p.note ? ' · ' + esc(p.note) : ''}</span></span>
          <span class="amt">${money(p.amount)}</span>
        </button></li>`).join('')}</ul>` : '<p class="muted">Aún no registras pagos.</p>'}
      </details>`;
  }

  function viewSettings() {
    const s = state.settings;
    const notifSupported = 'Notification' in window && 'serviceWorker' in navigator;
    const perm = notifSupported ? Notification.permission : 'unsupported';
    const notifText = !notifSupported ? 'Este navegador no permite notificaciones. Los avisos aparecerán en la pantalla de Inicio.'
      : s.notify && perm === 'granted' ? 'Activadas. Te avisaremos según los días configurados en cada obligación.'
      : perm === 'denied' ? 'Bloqueadas en el navegador. Actívalas en la configuración del sitio.'
      : 'Desactivadas. Los avisos se ven igual en la pantalla de Inicio.';
    const lastExp = s.lastExport ? `Último respaldo: ${fmtDate(s.lastExport)}.` : 'Aún no has hecho un respaldo.';
    const storageText = storageMode === 'idb' || storageMode === 'local'
      ? 'Tus datos se guardan solo en este dispositivo. No se envían a ningún servidor.'
      : 'Este navegador no permite guardar datos. Lo que registres se perderá al cerrar.';
    return `<h1>Ajustes</h1>
      ${installPrompt ? `<section class="card summary"><h3>Instalar la app</h3><p class="muted">Ábrela desde tu pantalla de inicio, sin navegador y sin conexión.</p><button class="btn primary block" data-action="install">Instalar</button></section>` : ''}
      <section class="card summary">
        <h3>Moneda</h3>
        <select class="input" id="set-currency" aria-label="Moneda">${CURRENCIES.map(([c, n]) => `<option value="${c}" ${c === s.currency ? 'selected' : ''}>${n} (${c})</option>`).join('')}</select>
      </section>
      <section class="card summary">
        <h3>Recordatorios</h3>
        <p class="muted">${notifText}</p>
        ${notifSupported && perm !== 'denied' ? `<button class="btn block ${s.notify && perm === 'granted' ? '' : 'primary'}" data-action="notify">${s.notify && perm === 'granted' ? 'Desactivar notificaciones' : 'Activar notificaciones'}</button>` : ''}
        <p class="small muted">En Android, instala la app para recibir avisos aunque esté cerrada. El sistema decide la hora exacta del aviso.</p>
      </section>
      <section class="card summary">
        <h3>PIN de acceso</h3>
        <p class="muted">${s.pinHash ? 'Activo. Se pide al abrir la app.' : 'Protege la app con un PIN de 4 a 8 dígitos.'}</p>
        ${crypto.subtle ? `<button class="btn block" data-action="pin">${s.pinHash ? 'Cambiar o quitar PIN' : 'Crear PIN'}</button>` : '<p class="small muted">Disponible cuando la app se abre desde una dirección segura (https).</p>'}
      </section>
      <section class="card summary">
        <h3>Respaldo y laptop</h3>
        <p class="muted">${storageText} ${lastExp}</p>
        <div class="btn-row"><button class="btn" data-action="export">Exportar</button><button class="btn" data-action="import">Importar</button></div>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
        <p class="small muted">Para usarla en tu laptop, abre la misma dirección en el navegador. Luego exporta el respaldo en el celular y envíatelo (correo, Drive o WhatsApp). Finalmente impórtalo en la laptop. Los datos no se sincronizan solos: registra los pagos en un equipo principal y copia el respaldo al otro.</p>
      </section>
      <p class="small muted" style="text-align:center">Mis Pagos · versión 1.0</p>`;
  }

  // ---------- Hojas ----------
  const sheet = $('#sheet');
  const sheetBody = $('#sheet-body');

  function openSheet(html, onReady) {
    sheetBody.innerHTML = html;
    if (!sheet.open) {
      sheet.showModal();
      history.pushState({ sheet: true }, '');
      sheetPushed = true;
    }
    if (onReady) onReady();
  }
  function closeSheet() {
    if (sheet.open) sheet.close();
    if (sheetPushed) { sheetPushed = false; ignorePop = true; history.back(); }
  }
  sheet.addEventListener('cancel', e => { e.preventDefault(); closeSheet(); });
  sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

  const head = title => `<div class="sheet-head"><h2 id="sheet-title">${title}</h2><button type="button" class="close" data-action="close" aria-label="Cerrar">×</button></div>`;

  function confirmSheet({ title, text, ok, danger }) {
    return new Promise(resolve => {
      openSheet(`${head(title)}<p>${text}</p>
        <div class="btn-row"><button type="button" class="btn" id="cf-no">Cancelar</button><button type="button" class="btn ${danger ? 'danger' : 'primary'}" id="cf-yes">${ok}</button></div>`, () => {
        $('#cf-no').onclick = () => { closeSheet(); resolve(false); };
        $('#cf-yes').onclick = () => { closeSheet(); resolve(true); };
      });
    });
  }

  function obligationSheet(o) {
    const isNew = !o;
    const today = C.todayStr();
    const maxPaidCuota = o ? Math.max(0, ...state.payments.filter(p => p.obligationId === o.id && p.type === 'cuota').map(p => p.cuota)) : 0;
    openSheet(`${head(isNew ? 'Nueva obligación' : 'Editar obligación')}
      <form id="ob-form" class="sheet-form" novalidate style="display:flex;flex-direction:column;gap:16px">
        <label class="field"><span>Nombre</span><input class="input" id="ob-name" required maxlength="60" placeholder="Ej.: Crédito auto" value="${esc(o?.name)}"></label>
        <div class="grid2">
          <label class="field"><span>Monto por cuota</span><input class="input" id="ob-amount" inputmode="decimal" placeholder="120.000" value="${amountInput(o?.amount)}"></label>
          <label class="field"><span>N.º de cuotas</span><input class="input" id="ob-total" type="number" inputmode="numeric" min="${Math.max(1, maxPaidCuota)}" max="600" placeholder="12" value="${o?.total ?? ''}"></label>
        </div>
        <label class="field"><span>Vencimiento de la primera cuota</span><input class="input" id="ob-due" type="date" value="${o?.firstDue ?? today}"><small>Periodicidad: mensual, el mismo día de cada mes.</small></label>
        <label class="field"><span>Recordarme</span><select class="input" id="ob-remind">${[0, 1, 2, 3, 5, 7, 10, 15].map(d => `<option value="${d}" ${(o?.reminderDays ?? 3) === d ? 'selected' : ''}>${d === 0 ? 'El mismo día' : `${d} ${d === 1 ? 'día' : 'días'} antes`}</option>`).join('')}</select></label>
        ${isNew ? `<label class="field"><span>Cuotas ya pagadas</span><input class="input" id="ob-prepaid" type="number" inputmode="numeric" min="0" value="0"><small>Si ya venías pagando, se registran automáticamente en su fecha.</small></label>` : ''}
        <p class="error" id="ob-error" hidden></p>
        <button class="btn primary block" type="submit">${isNew ? 'Crear obligación' : 'Guardar cambios'}</button>
      </form>`, () => {
      if (isNew) $('#ob-name').focus();
      $('#ob-form').addEventListener('submit', async e => {
        e.preventDefault();
        const name = $('#ob-name').value.trim();
        const amount = parseAmount($('#ob-amount').value);
        const total = parseInt($('#ob-total').value, 10);
        const firstDue = $('#ob-due').value;
        const reminderDays = parseInt($('#ob-remind').value, 10);
        const prepaid = isNew ? parseInt($('#ob-prepaid').value || '0', 10) : 0;
        const err = !name ? 'Escribe un nombre.'
          : !(amount > 0) ? 'Escribe un monto mayor que cero.'
          : !(total >= 1 && total <= 600) ? 'El número de cuotas debe estar entre 1 y 600.'
          : total < maxPaidCuota ? `Ya registraste la cuota ${maxPaidCuota}; el total no puede ser menor.`
          : !/^\d{4}-\d{2}-\d{2}$/.test(firstDue) ? 'Elige la fecha de vencimiento.'
          : !(prepaid >= 0 && prepaid <= total) ? 'Las cuotas ya pagadas no pueden superar el total.'
          : '';
        if (err) { const el = $('#ob-error'); el.textContent = err; el.hidden = false; return; }
        if (isNew) {
          const ob = { id: uid(), name, amount, total, firstDue, reminderDays, state: 'active', createdAt: new Date().toISOString() };
          state.obligations.push(ob);
          for (let n = 1; n <= prepaid; n++) {
            state.payments.push({ id: uid(), obligationId: ob.id, type: 'cuota', cuota: n, amount, date: C.addMonths(firstDue, n - 1), note: 'Registrada al crear' });
          }
          listFilter = 'active';
        } else {
          Object.assign(o, { name, amount, total, firstDue, reminderDays, updatedAt: new Date().toISOString() });
        }
        await save();
        closeSheet();
        render();
        toast(isNew ? 'Obligación creada' : 'Cambios guardados');
      });
    });
  }

  function paySheet(opts = {}) {
    const today = C.todayStr();
    const candidates = state.obligations.filter(o => o.state !== 'archived');
    if (!candidates.length) { obligationSheet(); return; }
    const sel = {
      id: opts.id && candidates.some(o => o.id === opts.id) ? opts.id : (C.upcoming(state, today)[0]?.o.id || candidates[0].id),
      type: opts.type || 'cuota',
      n: opts.n ? Number(opts.n) : null,
      amount: opts.amount, date: opts.date || today, note: opts.note || ''
    };
    const o = candidates.find(x => x.id === sel.id);
    const info = C.computeObligation(o, state.payments, today);
    const unpaid = info.cuotas.filter(c => c.status !== 'pagado');
    if (sel.type === 'cuota') {
      if (!unpaid.some(c => c.n === sel.n)) sel.n = unpaid[0]?.n ?? null;
      const c = unpaid.find(x => x.n === sel.n);
      if (sel.amount === undefined && c) sel.amount = c.pending;
    }
    const noCuotas = sel.type === 'cuota' && !unpaid.length;

    openSheet(`${head('Registrar pago')}
      <form id="pay-form" novalidate style="display:flex;flex-direction:column;gap:16px">
        <label class="field"><span>Obligación</span><select class="input" id="pay-ob">${candidates.map(x => `<option value="${x.id}" ${x.id === sel.id ? 'selected' : ''}>${esc(x.name)}${x.state === 'paused' ? ' (pausada)' : ''}</option>`).join('')}</select></label>
        <div class="seg" role="radiogroup" aria-label="Tipo de pago">
          <label><input type="radio" name="pay-type" value="cuota" ${sel.type === 'cuota' ? 'checked' : ''}><span>Cuota</span></label>
          <label><input type="radio" name="pay-type" value="extra" ${sel.type === 'extra' ? 'checked' : ''}><span>Abono extra</span></label>
        </div>
        ${sel.type === 'cuota'
          ? (noCuotas ? '<p class="alert info">Todas las cuotas de esta obligación están pagadas.</p>'
            : `<label class="field"><span>Cuota</span><select class="input" id="pay-n">${unpaid.map(c => `<option value="${c.n}" ${c.n === sel.n ? 'selected' : ''}>Cuota ${c.n} de ${o.total} · ${fmtShort(c.due)}${c.status === 'vencido' ? ' · vencida' : ''}</option>`).join('')}</select></label>`)
          : `<p class="small muted">El abono reduce el saldo y cubre las últimas cuotas primero. Saldo actual: ${money(info.remaining)}.</p>`}
        ${noCuotas ? '' : `<div class="grid2">
          <label class="field"><span>Monto</span><input class="input" id="pay-amount" inputmode="decimal" value="${amountInput(sel.amount)}" placeholder="0"></label>
          <label class="field"><span>Fecha de pago</span><input class="input" id="pay-date" type="date" value="${sel.date}" max="${C.addMonths(today, 12)}"></label>
        </div>
        <label class="field"><span>Nota (opcional)</span><input class="input" id="pay-note" maxlength="80" value="${esc(sel.note)}" placeholder="Ej.: transferencia"></label>
        <p class="error" id="pay-error" hidden></p>
        <button class="btn primary block" type="submit">Guardar pago</button>`}
      </form>`, () => {
      const keep = () => ({ amount: $('#pay-amount') ? parseAmount($('#pay-amount').value) : undefined, date: $('#pay-date')?.value, note: $('#pay-note')?.value });
      $('#pay-ob').onchange = e => paySheet({ id: e.target.value, type: sel.type, date: keep().date, note: keep().note });
      document.querySelectorAll('input[name="pay-type"]').forEach(r => r.onchange = e => {
        const k = keep();
        paySheet({ id: sel.id, type: e.target.value, date: k.date, note: k.note });
      });
      const nSel = $('#pay-n');
      if (nSel) nSel.onchange = e => { const k = keep(); paySheet({ id: sel.id, type: 'cuota', n: e.target.value, date: k.date, note: k.note }); };
      const form = $('#pay-form');
      form.addEventListener('submit', async e => {
        e.preventDefault();
        if (noCuotas) return;
        const amount = parseAmount($('#pay-amount').value);
        const date = $('#pay-date').value;
        const err = !(amount > 0) ? 'Escribe un monto mayor que cero.' : !/^\d{4}-\d{2}-\d{2}$/.test(date) ? 'Elige la fecha de pago.' : '';
        if (err) { const el = $('#pay-error'); el.textContent = err; el.hidden = false; return; }
        const p = { id: uid(), obligationId: sel.id, type: sel.type, amount, date, note: $('#pay-note').value.trim(), createdAt: new Date().toISOString() };
        if (sel.type === 'cuota') p.cuota = Number($('#pay-n').value);
        state.payments.push(p);
        await save();
        closeSheet();
        render();
        toast(sel.type === 'extra' ? 'Abono registrado' : `Cuota ${p.cuota} registrada`);
      });
    });
  }

  function editPaymentSheet(pid) {
    const p = state.payments.find(x => x.id === pid);
    if (!p) return;
    const o = state.obligations.find(x => x.id === p.obligationId);
    openSheet(`${head(p.type === 'extra' ? 'Abono extra' : `Cuota ${p.cuota} de ${o ? o.total : '?'}`)}
      <form id="ep-form" novalidate style="display:flex;flex-direction:column;gap:16px">
        <p class="muted">${esc(o ? o.name : '')}</p>
        <div class="grid2">
          <label class="field"><span>Monto</span><input class="input" id="ep-amount" inputmode="decimal" value="${amountInput(p.amount)}"></label>
          <label class="field"><span>Fecha de pago</span><input class="input" id="ep-date" type="date" value="${p.date}"></label>
        </div>
        <label class="field"><span>Nota</span><input class="input" id="ep-note" maxlength="80" value="${esc(p.note)}"></label>
        <p class="error" id="ep-error" hidden></p>
        <button class="btn primary block" type="submit">Guardar cambios</button>
        <button class="btn danger block" type="button" id="ep-del">Borrar este pago</button>
      </form>`, () => {
      $('#ep-form').addEventListener('submit', async e => {
        e.preventDefault();
        const amount = parseAmount($('#ep-amount').value);
        const date = $('#ep-date').value;
        if (!(amount > 0) || !date) { const el = $('#ep-error'); el.textContent = 'Revisa el monto y la fecha.'; el.hidden = false; return; }
        Object.assign(p, { amount, date, note: $('#ep-note').value.trim() });
        await save(); closeSheet(); render(); toast('Pago actualizado');
      });
      $('#ep-del').onclick = async () => {
        const ok = await confirmSheet({ title: 'Borrar pago', text: 'Se quitará este pago del historial. Úsalo solo para corregir un error.', ok: 'Borrar', danger: true });
        if (!ok) return;
        state.payments = state.payments.filter(x => x.id !== pid);
        await save(); render(); toast('Pago borrado');
      };
    });
  }

  async function sha(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function pinSheet() {
    const has = !!state.settings.pinHash;
    openSheet(`${head(has ? 'Cambiar PIN' : 'Crear PIN')}
      <form id="pin-form" novalidate autocomplete="off" style="display:flex;flex-direction:column;gap:16px">
        ${has ? '<label class="field"><span>PIN actual</span><input class="input" id="pin-cur" type="password" inputmode="numeric" maxlength="8"></label>' : ''}
        <label class="field"><span>${has ? 'PIN nuevo (vacío para quitarlo)' : 'PIN nuevo'}</span><input class="input" id="pin-new" type="password" inputmode="numeric" maxlength="8"></label>
        <label class="field"><span>Repite el PIN nuevo</span><input class="input" id="pin-rep" type="password" inputmode="numeric" maxlength="8"></label>
        <p class="small muted">Si olvidas el PIN tendrás que borrar los datos del sitio en el navegador. Mantén un respaldo exportado.</p>
        <p class="error" id="pin-error" hidden></p>
        <button class="btn primary block" type="submit">Guardar</button>
      </form>`, () => {
      $('#pin-form').addEventListener('submit', async e => {
        e.preventDefault();
        const fail = m => { const el = $('#pin-error'); el.textContent = m; el.hidden = false; };
        const s = state.settings;
        if (has && await sha(s.pinSalt + ':' + $('#pin-cur').value) !== s.pinHash) return fail('El PIN actual no es correcto.');
        const nw = $('#pin-new').value;
        if (nw !== $('#pin-rep').value) return fail('Los PIN nuevos no coinciden.');
        if (!nw && has) { s.pinHash = null; s.pinSalt = null; await save(); closeSheet(); render(); toast('PIN quitado'); return; }
        if (!/^\d{4,8}$/.test(nw)) return fail('El PIN debe tener entre 4 y 8 dígitos.');
        s.pinSalt = uid();
        s.pinHash = await sha(s.pinSalt + ':' + nw);
        await save(); closeSheet(); render(); toast('PIN guardado');
      });
    });
  }

  // ---------- Respaldo ----------
  async function exportData() {
    const { pinHash, pinSalt, ...settings } = state.settings;
    const data = { app: 'mis-pagos', exportedAt: new Date().toISOString(), version: 1, obligations: state.obligations, payments: state.payments, settings };
    const name = `mis-pagos-${C.todayStr()}.json`;
    const file = new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' });
    let shared = false;
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Respaldo Mis Pagos' });
        shared = true;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    if (!shared) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
    state.settings.lastExport = C.todayStr();
    await save();
    render();
    toast('Respaldo exportado');
  }

  async function importData(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { toast('El archivo no es un respaldo válido'); return; }
    if (!data || data.app !== 'mis-pagos' || !Array.isArray(data.obligations) || !Array.isArray(data.payments)) {
      toast('El archivo no es un respaldo de Mis Pagos'); return;
    }
    const ok = await confirmSheet({
      title: 'Importar respaldo',
      text: `El respaldo tiene ${data.obligations.length} obligaciones y ${data.payments.length} pagos${data.exportedAt ? ` (exportado el ${fmtDate(data.exportedAt.slice(0, 10))})` : ''}. Reemplazará los datos de este dispositivo.`,
      ok: 'Reemplazar datos', danger: true
    });
    if (!ok) return;
    const keep = { pinHash: state.settings.pinHash, pinSalt: state.settings.pinSalt, notify: state.settings.notify };
    state = normalize({ obligations: data.obligations, payments: data.payments, settings: { ...(data.settings || {}), ...keep } });
    await save();
    tab = 'home'; detailId = null;
    render();
    toast('Datos importados');
  }

  // ---------- Notificaciones ----------
  let swReg = null;
  async function runReminders() {
    if (!swReg || !state.settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    try { await C.notifyDue(swReg, state); } catch (e) { /* sin avisos del sistema */ }
  }
  async function registerPeriodic() {
    try {
      if (!swReg || !('periodicSync' in swReg)) return;
      const st = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (st.state === 'granted') await swReg.periodicSync.register('recordatorios', { minInterval: 12 * 60 * 60 * 1000 });
    } catch (e) { /* no disponible */ }
  }
  async function toggleNotify() {
    if (state.settings.notify && Notification.permission === 'granted') {
      state.settings.notify = false;
      try { await swReg?.periodicSync?.unregister('recordatorios'); } catch (e) { /* nada */ }
    } else {
      const perm = await Notification.requestPermission();
      state.settings.notify = perm === 'granted';
      if (!state.settings.notify) toast('No se concedió el permiso');
      else { await registerPeriodic(); toast('Notificaciones activadas'); }
    }
    await save();
    render();
    runReminders();
  }

  // ---------- Instalación ----------
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (tab === 'settings') render(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; render(); });

  // ---------- Eventos ----------
  document.querySelector('.tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) go(b.dataset.tab);
  });

  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const { action, id } = el.dataset;
    const o = id && state.obligations.find(x => x.id === id);
    switch (action) {
      case 'close': closeSheet(); break;
      case 'new-ob': obligationSheet(); break;
      case 'edit': obligationSheet(o); break;
      case 'pay': paySheet({ id, n: el.dataset.n }); break;
      case 'extra': paySheet({ id, type: 'extra' }); break;
      case 'edit-pay': editPaymentSheet(el.dataset.pid); break;
      case 'detail': openDetail(id); break;
      case 'back': history.back(); break;
      case 'filter': listFilter = el.dataset.f; render(); break;
      case 'month': {
        const [y, m] = homeMonth.split('-').map(Number);
        homeMonth = C.addMonths(`${y}-${String(m).padStart(2, '0')}-01`, Number(el.dataset.d)).slice(0, 7);
        render(); break;
      }
      case 'month-today': homeMonth = C.todayStr().slice(0, 7); render(); break;
      case 'toggle-pause':
        o.state = o.state === 'paused' ? 'active' : 'paused';
        await save(); render(); toast(o.state === 'paused' ? 'Obligación pausada' : 'Obligación reanudada'); break;
      case 'archive': {
        const ok = await confirmSheet({ title: 'Eliminar obligación', text: `“${esc(o.name)}” dejará de aparecer en tus pagos. Su historial de pagos se conserva en Obligaciones › Eliminadas y puedes restaurarla.`, ok: 'Eliminar', danger: true });
        if (!ok) return;
        o.state = 'archived'; o.archivedAt = new Date().toISOString();
        await save(); render(); toast('Obligación eliminada. Historial conservado'); break;
      }
      case 'restore':
        o.state = 'active'; await save(); render(); toast('Obligación restaurada'); break;
      case 'purge': {
        const ok = await confirmSheet({ title: 'Borrar para siempre', text: `Se borrará “${esc(o.name)}” y todo su historial de pagos. Esto no se puede deshacer.`, ok: 'Borrar todo', danger: true });
        if (!ok) return;
        state.obligations = state.obligations.filter(x => x.id !== o.id);
        state.payments = state.payments.filter(p => p.obligationId !== o.id);
        detailId = null;
        await save(); render(); toast('Borrada'); break;
      }
      case 'notify': toggleNotify(); break;
      case 'pin': pinSheet(); break;
      case 'export': exportData(); break;
      case 'import': $('#import-file').click(); break;
      case 'install':
        if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice.catch(() => null); installPrompt = null; render(); }
        break;
    }
  });

  document.addEventListener('change', async e => {
    if (e.target.id === 'set-currency') {
      state.settings.currency = e.target.value;
      await save(); toast('Moneda actualizada');
    } else if (e.target.id === 'import-file' && e.target.files[0]) {
      const f = e.target.files[0];
      e.target.value = '';
      importData(f);
    }
  });

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ---------- Bloqueo con PIN ----------
  let hiddenAt = 0, attempts = 0, blockedUntil = 0;
  function lock() {
    if (!state.settings.pinHash) return;
    if (sheet.open) closeSheet();
    $('#lock').hidden = false;
    $('#lock-error').hidden = true;
    $('#lock-pin').value = '';
    setTimeout(() => $('#lock-pin').focus(), 50);
  }
  $('#lock-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#lock-error');
    if (Date.now() < blockedUntil) { err.textContent = 'Demasiados intentos. Espera unos segundos.'; err.hidden = false; return; }
    const s = state.settings;
    if (await sha(s.pinSalt + ':' + $('#lock-pin').value) === s.pinHash) {
      attempts = 0;
      $('#lock').hidden = true;
      render();
      runReminders();
    } else {
      attempts++;
      if (attempts >= 5) { blockedUntil = Date.now() + 30000; attempts = 0; }
      err.textContent = 'PIN incorrecto.'; err.hidden = false;
      $('#lock-pin').value = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else {
      if (state.settings.pinHash && hiddenAt && Date.now() - hiddenAt > 2 * 60 * 1000) lock();
      else { render(); runReminders(); }
    }
  });

  // ---------- Inicio ----------
  (async function init() {
    await load();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      try {
        swReg = await navigator.serviceWorker.register('sw.js');
        await navigator.serviceWorker.ready;
        if (state.settings.notify) registerPeriodic();
      } catch (e) { swReg = null; }
    }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* opcional */ }
    if (state.settings.pinHash && crypto.subtle) lock();
    else { render(); runReminders(); }
  })();
})();
