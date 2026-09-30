/* Lógica compartida entre la app y el service worker (cálculos, fechas y almacenamiento). */
(function (g) {
  'use strict';

  const pad = n => String(n).padStart(2, '0');
  const EPS = 0.005;

  function todayStr(d = new Date()) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function parse(s) {
    const [y, m, d] = s.split('-').map(Number);
    return { y, m, d };
  }

  // Suma meses manteniendo el día; si el mes es más corto, usa su último día (31 ene → 28 feb).
  function addMonths(s, k) {
    const { y, m, d } = parse(s);
    const t = (m - 1) + k;
    const ny = y + Math.floor(t / 12);
    const nm = ((t % 12) + 12) % 12;
    const dim = new Date(ny, nm + 1, 0).getDate();
    return ny + '-' + pad(nm + 1) + '-' + pad(Math.min(d, dim));
  }

  function daysBetween(a, b) {
    const A = parse(a), B = parse(b);
    return Math.round((Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d)) / 864e5);
  }

  // Estado completo de una obligación. Los abonos extraordinarios se aplican
  // desde la última cuota hacia atrás (reducen el plazo).
  function computeObligation(o, payments, today) {
    const pays = payments.filter(p => p.obligationId === o.id);
    const byCuota = {};
    let extra = 0;
    for (const p of pays) {
      if (p.type === 'extra') extra += p.amount;
      else byCuota[p.cuota] = (byCuota[p.cuota] || 0) + p.amount;
    }
    const cuotas = [];
    for (let n = 1; n <= o.total; n++) {
      const paid = Math.min(o.amount, byCuota[n] || 0);
      cuotas.push({ n, due: addMonths(o.firstDue, n - 1), paid, extra: 0, pending: o.amount - paid });
    }
    let pool = extra;
    for (let i = cuotas.length - 1; i >= 0 && pool > EPS; i--) {
      const c = cuotas[i];
      const use = Math.min(pool, c.pending);
      c.extra = use;
      c.pending -= use;
      pool -= use;
    }
    let paidCount = 0, remaining = 0, overdueCount = 0, overdueAmount = 0, next = null;
    for (const c of cuotas) {
      if (c.pending <= EPS) {
        c.pending = 0;
        c.status = 'pagado';
        paidCount++;
      } else {
        c.status = c.due < today ? 'vencido' : 'pendiente';
        remaining += c.pending;
        if (c.status === 'vencido') { overdueCount++; overdueAmount += c.pending; }
        if (!next) next = c;
      }
    }
    const totalAmount = o.amount * o.total;
    const paidTotal = pays.reduce((s, p) => s + p.amount, 0);
    const complete = !next;
    const status = o.state === 'archived' ? 'archivada'
      : o.state === 'paused' ? 'pausada'
      : complete ? 'pagado'
      : overdueCount ? 'vencido' : 'pendiente';
    return {
      o, cuotas, paidCount, remaining, totalAmount, paidTotal, extraTotal: extra,
      percent: totalAmount ? (totalAmount - remaining) / totalAmount : 1,
      overdueCount, overdueAmount, next, complete, status, payments: pays
    };
  }

  // Cuotas vencidas + la siguiente por vencer de cada obligación activa, por fecha.
  function upcoming(state, today) {
    const out = [];
    for (const o of state.obligations) {
      if (o.state !== 'active') continue;
      const info = computeObligation(o, state.payments, today);
      for (const c of info.cuotas) {
        if (c.status === 'vencido') out.push({ o, info, c, days: daysBetween(today, c.due) });
        else if (c.status === 'pendiente') {
          out.push({ o, info, c, days: daysBetween(today, c.due) });
          break;
        }
      }
    }
    return out.sort((a, b) => a.c.due < b.c.due ? -1 : a.c.due > b.c.due ? 1 : 0);
  }

  // Pagos que entran en la ventana de recordatorio (incluye vencidos).
  function reminders(state, today) {
    return upcoming(state, today).filter(u => u.days <= (u.o.reminderDays ?? 3));
  }

  function monthSummary(state, ym, today) {
    let toPay = 0, pending = 0, extras = 0, count = 0, paidCount = 0;
    const ids = new Set();
    for (const o of state.obligations) {
      if (o.state !== 'active') continue;
      ids.add(o.id);
      const info = computeObligation(o, state.payments, today);
      for (const c of info.cuotas) {
        if (c.due.slice(0, 7) !== ym) continue;
        toPay += o.amount;
        pending += c.pending;
        count++;
        if (c.status === 'pagado') paidCount++;
      }
    }
    for (const p of state.payments) {
      if (p.type === 'extra' && ids.has(p.obligationId) && p.date.slice(0, 7) === ym) extras += p.amount;
    }
    return { toPay, pending, paid: toPay - pending, extras, count, paidCount };
  }

  function money(v, currency) {
    try {
      return new Intl.NumberFormat('es-CL', { style: 'currency', currency: currency || 'CLP' }).format(v || 0);
    } catch (e) {
      return (currency || '$') + ' ' + Math.round(v || 0);
    }
  }

  // ---- IndexedDB (lo usan la página y el service worker) ----
  const DB_NAME = 'mis-pagos', STORE = 'kv';

  function idbOpen() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE).objectStore(STORE).get(key);
      t.onsuccess = () => res(t.result);
      t.onerror = () => rej(t.error);
    });
  }

  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  function dueLabel(days) {
    if (days === 0) return 'vence hoy';
    if (days === 1) return 'vence mañana';
    if (days > 1) return 'vence en ' + days + ' días';
    if (days === -1) return 'venció ayer';
    return 'venció hace ' + (-days) + ' días';
  }

  // Muestra una notificación por cuota y por día (no repite el mismo aviso).
  async function notifyDue(registration, state, today) {
    today = today || todayStr();
    let log;
    try { log = await idbGet('notified'); } catch (e) { log = null; }
    if (!log || log.date !== today) log = { date: today, keys: [] };
    const cur = state.settings && state.settings.currency;
    for (const r of reminders(state, today)) {
      const key = r.o.id + ':' + r.c.n;
      if (log.keys.includes(key)) continue;
      await registration.showNotification(r.o.name + ': ' + dueLabel(r.days), {
        body: 'Cuota ' + r.c.n + ' de ' + r.o.total + ' · ' + money(r.c.pending, cur),
        tag: key,
        icon: 'icon-192.png',
        badge: 'icon-192.png'
      });
      log.keys.push(key);
    }
    try { await idbSet('notified', log); } catch (e) { /* sin registro: puede repetir */ }
  }

  g.PagosCore = {
    todayStr, parse, addMonths, daysBetween, computeObligation, upcoming, reminders,
    monthSummary, money, idbGet, idbSet, dueLabel, notifyDue
  };
})(typeof self !== 'undefined' ? self : this);
