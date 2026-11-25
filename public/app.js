'use strict';

/* ============================================================
   Seating Planner — all data lives in this browser (localStorage)
   Units: everything on the paper is measured in inches.
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r3 = v => Math.round(v * 1000) / 1000;

const STORE = 'seating-planner.v1';
const PAPERS = {
  letter: { w: 8.5, h: 11, name: 'Letter (8.5 × 11 in)' },
  legal: { w: 8.5, h: 14, name: 'Legal (8.5 × 14 in)' },
  tabloid: { w: 11, h: 17, name: 'Tabloid (11 × 17 in)' },
  a4: { w: 8.27, h: 11.69, name: 'A4 (210 × 297 mm)' },
  a3: { w: 11.69, h: 16.54, name: 'A3 (297 × 420 mm)' },
};
const MARGIN = 0.5;
const SNAP = 0.125;
const SEAT_R = 0.17;
const PX = 96; // screen px per inch at 100%
const TYPE_NAMES = { round: 'Round table', rect: 'Table', row: 'Row of seats', seat: 'Single seat', area: 'Area', text: 'Text label' };
const COLORS = {
  ink: '#1b2430', ink2: '#4a5563', ink3: '#8a94a3',
  table: '#eef3f9', tableStroke: '#1f3a5f',
  seat: '#ffffff', seatStroke: '#5b6776', seatFill: '#1f3a5f',
  area: '#f3f5f8', areaStroke: '#9aa4b2',
  sel: '#2f6fb3', hit: '#f2b705',
};

/* ---------------- State ---------------- */
function newChart(name) {
  return { id: uid(), name, title: name, subtitle: '', paper: 'letter', orient: 'landscape', items: [] };
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && Array.isArray(s.charts) && s.charts.length) return migrate(s);
  } catch (e) { /* ignore */ }
  const c = newChart('Seating Chart');
  return { charts: [c], currentId: c.id };
}
let state = load();
let sel = null;
let zoom = 1;
let snapOn = true;
let search = '';
let undoStack = [], redoStack = [];
let saveTimer = null;

const chart = () => state.charts.find(c => c.id === state.currentId) || state.charts[0];
const findItem = id => chart().items.find(i => i.id === id);
function paperDims(c) {
  const p = PAPERS[c.paper] || PAPERS.letter;
  return c.orient === 'landscape' ? [p.h, p.w] : [p.w, p.h];
}

/* Saves go to localStorage immediately (instant, offline-safe) and to the
   server shortly after (so charts follow you to any device). */
let dirty = false, inflight = false, retryTimer = null;
function setStatus(text, kind) {
  const el = $('#saved');
  el.textContent = text;
  el.className = 'saved show ' + (kind || '');
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* ignore */ }
  dirty = true;
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(pushToServer, 600);
}
async function pushToServer() {
  if (inflight) { clearTimeout(saveTimer); saveTimer = setTimeout(pushToServer, 300); return; }
  if (!dirty) return;
  inflight = true; dirty = false;
  clearTimeout(retryTimer);
  try {
    const res = await fetch('/api/state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state), credentials: 'same-origin' });
    if (res.status === 401) { location.href = '/'; return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (!dirty) setStatus('All changes saved', 'ok');
  } catch (e) {
    dirty = true;
    setStatus('Offline — will retry', 'warn');
    retryTimer = setTimeout(pushToServer, 5000);
  } finally {
    inflight = false;
  }
}
window.addEventListener('beforeunload', e => {
  if (!dirty && !inflight) return;
  try { fetch('/api/state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state), keepalive: true, credentials: 'same-origin' }); } catch (err) { /* ignore */ }
  e.preventDefault(); e.returnValue = '';
});
function migrate(s) {
  // Tables are rectangles: convert any older round tables.
  s.charts.forEach(c => c.items.forEach(it => { if (it.type === 'round') { it.type = 'rect'; it.ends = false; } }));
  return s;
}
function snapshot() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}
function restore(json) {
  state = JSON.parse(json);
  if (sel && !findItem(sel)) sel = null;
  save(); renderAll();
}
function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(state)); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(state)); restore(redoStack.pop()); }
function updateUndoButtons() {
  $('#btn-undo').disabled = !undoStack.length;
  $('#btn-redo').disabled = !redoStack.length;
}
/* Mutate with one undo step */
function mutate(fn, { inspector = true } = {}) {
  snapshot(); fn(); save(); renderCanvas(); renderSidebar(); if (inspector) renderInspector();
}

/* ---------------- Geometry ---------------- */
function rot(x, y, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

function geom(it) {
  const n = (it.seats || []).length;
  const local = [];
  let shape = null, labelAt = [0, 0];
  switch (it.type) {
    case 'round': {
      const ring = Math.max(0.62, n * 0.44 / (2 * Math.PI));
      shape = { kind: 'circle', r: ring - 0.25 };
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + i * 2 * Math.PI / n;
        local.push([Math.cos(a) * ring, Math.sin(a) * ring, Math.cos(a), Math.sin(a)]);
      }
      break;
    }
    case 'rect': {
      const endN = it.ends ? Math.min(2, n) : 0;
      const side = n - endN, top = Math.ceil(side / 2), bot = side - top;
      const L = Math.max(0.9, Math.max(top, 1) * 0.48), D = 0.6, off = D / 2 + 0.24;
      shape = { kind: 'rect', w: L, h: D };
      for (let i = 0; i < top; i++) local.push([-L / 2 + (i + 0.5) * L / top, -off, 0, -1]);
      if (endN >= 1) local.push([L / 2 + 0.24, 0, 1, 0]);
      for (let i = bot - 1; i >= 0; i--) local.push([-L / 2 + (i + 0.5) * L / bot, off, 0, 1]);
      if (endN >= 2) local.push([-L / 2 - 0.24, 0, -1, 0]);
      break;
    }
    case 'row': {
      for (let i = 0; i < n; i++) local.push([(i - (n - 1) / 2) * 0.46, 0, 0, 1]);
      labelAt = [0, -0.36];
      break;
    }
    case 'seat': local.push([0, 0, 0, 1]); labelAt = null; break;
    case 'area': shape = { kind: 'rect', w: it.w, h: it.h }; break;
    default: break;
  }
  const seats = local.map(([lx, ly, nx, ny]) => {
    const [x, y] = rot(lx, ly, it.rot || 0);
    const [wx, wy] = rot(nx, ny, it.rot || 0);
    return { x: it.x + x, y: it.y + y, nx: wx, ny: wy };
  });
  const lbl = labelAt ? rot(labelAt[0], labelAt[1], it.rot || 0) : null;
  return { seats, shape, label: lbl ? [it.x + lbl[0], it.y + lbl[1]] : null };
}

function bbox(it) {
  const g = geom(it);
  const xs = [], ys = [];
  const push = (x, y, r = 0) => { xs.push(x - r, x + r); ys.push(y - r, y + r); };
  g.seats.forEach(s => push(s.x, s.y, SEAT_R));
  if (g.shape) {
    if (g.shape.kind === 'circle') push(it.x, it.y, g.shape.r);
    else {
      const { w, h } = g.shape;
      [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].forEach(([a, b]) => { const [x, y] = rot(a, b, it.rot || 0); push(it.x + x, it.y + y); });
    }
  }
  if (it.type === 'text') {
    const fs = (it.size || 18) / 72, w = Math.max(0.4, (it.text || '').length * fs * 0.55);
    push(it.x - w / 2, it.y - fs * 0.8); push(it.x + w / 2, it.y + fs * 0.3);
  }
  if (it.type === 'row' && g.label) push(g.label[0], g.label[1], 0.1);
  if (!xs.length) push(it.x, it.y, 0.3);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

/* ---------------- SVG rendering ---------------- */
function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function nameLines(name) {
  const t = name.trim();
  if (t.length <= 11 || !t.includes(' ')) return [t];
  const i = t.indexOf(' ');
  return [t.slice(0, i), t.slice(i + 1)];
}

function seatLabelSVG(s, name) {
  const lines = nameLines(name);
  const d = SEAT_R + 0.05;
  const x = s.x + s.nx * d, y = s.y + s.ny * d;
  const anchor = s.nx > 0.38 ? 'start' : s.nx < -0.38 ? 'end' : 'middle';
  const LH = 1.08;
  let first;
  if (s.ny > 0.38) first = 0.85;
  else if (s.ny < -0.38) first = -0.3 - (lines.length - 1) * LH;
  else first = 0.35 - (lines.length - 1) * LH / 2;
  const tspans = lines.map((l, i) => `<tspan x="${r3(x)}" dy="${i === 0 ? first : LH}em">${esc(l)}</tspan>`).join('');
  return `<text x="${r3(x)}" y="${r3(y)}" font-size="0.105" fill="${COLORS.ink}" text-anchor="${anchor}" font-weight="500">${tspans}</text>`;
}

function itemSVG(it, opts) {
  const g = geom(it);
  const out = [];
  const q = search.trim().toLowerCase();
  // shape
  if (g.shape && it.type !== 'area') {
    if (g.shape.kind === 'circle') out.push(`<circle cx="${r3(it.x)}" cy="${r3(it.y)}" r="${r3(g.shape.r)}" fill="${COLORS.table}" stroke="${COLORS.tableStroke}" stroke-width="0.02"/>`);
    else out.push(`<rect x="${r3(-g.shape.w / 2)}" y="${r3(-g.shape.h / 2)}" width="${r3(g.shape.w)}" height="${r3(g.shape.h)}" rx="0.04" transform="translate(${r3(it.x)} ${r3(it.y)}) rotate(${it.rot || 0})" fill="${COLORS.table}" stroke="${COLORS.tableStroke}" stroke-width="0.02"/>`);
  }
  if (it.type === 'area') {
    out.push(`<rect x="${r3(-it.w / 2)}" y="${r3(-it.h / 2)}" width="${r3(it.w)}" height="${r3(it.h)}" rx="0.05" transform="translate(${r3(it.x)} ${r3(it.y)}) rotate(${it.rot || 0})" fill="${COLORS.area}" stroke="${COLORS.areaStroke}" stroke-width="0.018" stroke-dasharray="0.08 0.05"/>`);
    if (it.label) out.push(`<text x="${r3(it.x)}" y="${r3(it.y)}" dy="0.35em" font-size="0.17" font-weight="600" letter-spacing="0.02" fill="${COLORS.ink2}" text-anchor="middle">${esc(it.label.toUpperCase())}</text>`);
  }
  // seats
  g.seats.forEach((s, i) => {
    const name = (it.seats[i] || '').trim();
    const hit = q && name && name.toLowerCase().includes(q);
    if (hit && !opts.print) out.push(`<circle cx="${r3(s.x)}" cy="${r3(s.y)}" r="${SEAT_R + 0.07}" fill="${COLORS.hit}" opacity="0.55"/>`);
    out.push(`<circle class="seat-c" data-seat="${i}" cx="${r3(s.x)}" cy="${r3(s.y)}" r="${SEAT_R}" fill="${name ? COLORS.seatFill : COLORS.seat}" stroke="${name ? COLORS.seatFill : COLORS.seatStroke}" stroke-width="0.016"/>`);
    if (name) out.push(`<text x="${r3(s.x)}" y="${r3(s.y)}" dy="0.36em" font-size="0.1" font-weight="600" fill="#fff" text-anchor="middle" pointer-events="none">${esc(initials(name))}</text>`);
    else if (!opts.print || opts.numbers) out.push(`<text x="${r3(s.x)}" y="${r3(s.y)}" dy="0.36em" font-size="0.09" fill="${COLORS.ink3}" text-anchor="middle" pointer-events="none">${i + 1}</text>`);
    if (name) out.push(seatLabelSVG(s, name));
  });
  // table label
  if ((it.type === 'round' || it.type === 'rect') && it.label) {
    const fs = it.type === 'round' ? clamp(geom(it).shape.r * 0.32, 0.11, 0.2) : 0.14;
    out.push(`<text x="${r3(it.x)}" y="${r3(it.y)}" dy="0.36em" font-size="${r3(fs)}" font-weight="700" fill="${COLORS.tableStroke}" text-anchor="middle">${esc(it.label)}</text>`);
  }
  if (it.type === 'row' && it.label && g.label) {
    out.push(`<text x="${r3(g.label[0])}" y="${r3(g.label[1])}" dy="0.36em" font-size="0.12" font-weight="700" fill="${COLORS.tableStroke}" text-anchor="middle">${esc(it.label)}</text>`);
  }
  if (it.type === 'text') {
    const fs = (it.size || 18) / 72;
    out.push(`<text x="${r3(it.x)}" y="${r3(it.y)}" dy="0.35em" font-size="${r3(fs)}" font-weight="${it.bold ? 700 : 500}" fill="${COLORS.ink}" text-anchor="middle" transform="rotate(${it.rot || 0} ${r3(it.x)} ${r3(it.y)})">${esc(it.text || 'Text')}</text>`);
  }
  // selection
  let selBox = '';
  if (!opts.print && sel === it.id) {
    const b = bbox(it), p = 0.08;
    selBox = `<rect x="${r3(b.x1 - p)}" y="${r3(b.y1 - p)}" width="${r3(b.x2 - b.x1 + 2 * p)}" height="${r3(b.y2 - b.y1 + 2 * p)}" fill="none" stroke="${COLORS.sel}" stroke-width="0.015" stroke-dasharray="0.06 0.04" rx="0.04" pointer-events="none"/>`;
  }
  const hitBox = !opts.print ? (() => { const b = bbox(it); return `<rect x="${r3(b.x1)}" y="${r3(b.y1)}" width="${r3(b.x2 - b.x1)}" height="${r3(b.y2 - b.y1)}" fill="transparent"/>`; })() : '';
  return `<g class="item" data-id="${it.id}">${it.type === 'area' ? '' : hitBox}${out.join('')}${selBox}</g>`;
}

function chartSVG(c, opts = {}) {
  const [W, H] = paperDims(c);
  const parts = [];
  if (!opts.print) {
    if (snapOn) {
      let grid = '';
      for (let x = 0.5; x < W; x += 0.5) grid += `M${r3(x)} 0V${r3(H)}`;
      for (let y = 0.5; y < H; y += 0.5) grid += `M0 ${r3(y)}H${r3(W)}`;
      parts.push(`<path d="${grid}" stroke="#e9edf2" stroke-width="0.008" fill="none" pointer-events="none"/>`);
    }
    parts.push(`<rect x="${MARGIN}" y="${MARGIN}" width="${r3(W - 2 * MARGIN)}" height="${r3(H - 2 * MARGIN)}" fill="none" stroke="#c9d3df" stroke-width="0.01" stroke-dasharray="0.05 0.05" pointer-events="none"/>`);
  }
  // header
  let headerBottom = MARGIN;
  if (c.title) {
    parts.push(`<text x="${r3(W / 2)}" y="${MARGIN + 0.3}" font-size="0.3" font-weight="700" fill="${COLORS.ink}" text-anchor="middle" letter-spacing="-0.004">${esc(c.title)}</text>`);
    headerBottom = MARGIN + 0.42;
  }
  if (c.subtitle) {
    const y = c.title ? MARGIN + 0.56 : MARGIN + 0.18;
    parts.push(`<text x="${r3(W / 2)}" y="${y}" font-size="0.14" fill="${COLORS.ink2}" text-anchor="middle">${esc(c.subtitle)}</text>`);
    headerBottom = y + 0.12;
  }
  if (c.title || c.subtitle) {
    parts.push(`<line x1="${r3(W / 2 - 0.6)}" x2="${r3(W / 2 + 0.6)}" y1="${r3(headerBottom + 0.08)}" y2="${r3(headerBottom + 0.08)}" stroke="${COLORS.tableStroke}" stroke-width="0.02"/>`);
  }
  // items: areas first so they sit beneath tables
  const items = [...c.items].sort((a, b) => (a.type === 'area' ? 0 : 1) - (b.type === 'area' ? 0 : 1));
  items.forEach(it => parts.push(itemSVG(it, opts)));
  const size = opts.print ? '' : `width="${r3(W * PX * zoom)}" height="${r3(H * PX * zoom)}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="paper" viewBox="0 0 ${W} ${H}" ${size} font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"><rect width="${W}" height="${H}" fill="#fff"/>${parts.join('')}</svg>`;
}

/* ---------------- Render: canvas / sidebar / inspector ---------------- */
function renderCanvas() {
  $('#paper-wrap').innerHTML = chartSVG(chart());
  $('#btn-zoom-fit').textContent = Math.round(zoom * 100) + '%';
}

function seatStats(c) {
  let seats = 0, filled = 0, tables = 0;
  c.items.forEach(it => {
    if (it.type === 'round' || it.type === 'rect') tables++;
    (it.seats || []).forEach(n => { seats++; if ((n || '').trim()) filled++; });
  });
  return { seats, filled, tables };
}

function renderSidebar() {
  $('#chart-list').innerHTML = state.charts.map(c => {
    const st = seatStats(c);
    return `<li data-chart="${c.id}" class="${c.id === state.currentId ? 'active' : ''}">
      <svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="12" r="3"/></svg>
      <span class="nm">${esc(c.name || 'Untitled')}</span><span class="ct">${st.filled}/${st.seats}</span></li>`;
  }).join('');
}

function itemDisplayName(it) {
  if (it.type === 'text') return it.text || 'Text';
  return it.label || TYPE_NAMES[it.type];
}

function stepper(field, val, min, max) {
  return `<div class="stepper"><button data-step="${field}" data-d="-1" type="button">−</button><input class="num-in" data-field="${field}" type="number" min="${min}" max="${max}" value="${val}"><button data-step="${field}" data-d="1" type="button">+</button></div>`;
}

function renderInspector() {
  const el = $('#inspector');
  const it = sel && findItem(sel);
  if (!it) { el.innerHTML = chartInspector(); return; }
  const parts = [];
  if (it.type !== 'text') {
    parts.push(`<div class="field"><label>${it.type === 'area' ? 'Label' : 'Name / number'}</label><input class="inp" data-field="label" value="${esc(it.label || '')}" placeholder="${it.type === 'area' ? 'e.g. Stage, Dance floor' : 'e.g. Table 1'}"></div>`);
  } else {
    parts.push(`<div class="field"><label>Text</label><input class="inp" data-field="text" value="${esc(it.text || '')}"></div>`);
    parts.push(`<div class="row2"><div class="field"><label>Size (pt)</label>${stepper('size', it.size || 18, 6, 96)}</div><div class="field"><span class="lbl">&nbsp;</span><label class="check"><input type="checkbox" data-field="bold" ${it.bold ? 'checked' : ''}> Bold</label></div></div>`);
  }
  if (['round', 'rect', 'row'].includes(it.type)) {
    parts.push(`<div class="field"><label>Number of seats</label>${stepper('count', it.seats.length, 1, 40)}</div>`);
  }
  if (it.type === 'rect') {
    parts.push(`<label class="check"><input type="checkbox" data-field="ends" ${it.ends ? 'checked' : ''}> Seats at the ends</label>`);
  }
  if (it.type === 'area') {
    parts.push(`<div class="row2"><div class="field"><label>Width (in)</label><input class="inp" type="number" step="0.25" min="0.25" data-field="w" value="${it.w}"></div><div class="field"><label>Height (in)</label><input class="inp" type="number" step="0.25" min="0.25" data-field="h" value="${it.h}"></div></div>`);
  }
  if (it.type !== 'seat' && it.type !== 'round') {
    parts.push(`<div class="field"><label>Rotation</label><div class="range-row"><input type="range" min="0" max="345" step="15" data-field="rot" value="${it.rot || 0}"><span class="val">${it.rot || 0}°</span></div></div>`);
  }
  if (it.seats) {
    const filled = it.seats.filter(s => (s || '').trim()).length;
    parts.push('<hr class="divider">');
    parts.push(`<div class="field"><span class="lbl">Guests <span class="seat-count" style="color:var(--ink-3);font-weight:400">· ${filled} of ${it.seats.length} seated</span></span><div class="seat-list">${it.seats.map((n, i) => `
      <div class="seat-row ${(n || '').trim() ? 'filled' : ''}" data-row="${i}"><span class="num">${i + 1}</span><input class="inp" data-seat-name="${i}" value="${esc(n || '')}" placeholder="Guest name"></div>`).join('')}</div></div>`);
  }
  parts.push('<hr class="divider">');
  parts.push(`<div class="btn-row"><button class="btn sm" data-act="dup">Duplicate</button>${it.seats && it.seats.length > 1 ? '<button class="btn sm" data-act="clear-item">Clear names</button>' : ''}<button class="btn sm danger" data-act="del">Delete</button></div>`);

  el.innerHTML = `<div class="insp-head"><div class="kind">${TYPE_NAMES[it.type]}</div><h2>${esc(itemDisplayName(it))}</h2></div><div class="insp-body">${parts.join('')}</div>`;
}

function chartInspector() {
  const c = chart();
  const st = seatStats(c);
  const pct = st.seats ? Math.round(st.filled / st.seats * 100) : 0;
  const guests = [];
  c.items.forEach(it => (it.seats || []).forEach((n, i) => { if ((n || '').trim()) guests.push({ name: n.trim(), where: itemDisplayName(it), id: it.id, i }); }));
  guests.sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="insp-head"><div class="kind">Chart settings</div><h2>${esc(c.name || 'Untitled')}</h2></div>
  <div class="insp-body">
    <div class="field"><label>Chart name</label><input class="inp" data-chart-field="name" value="${esc(c.name)}"></div>
    <div class="field"><label>Printed title</label><input class="inp" data-chart-field="title" value="${esc(c.title)}" placeholder="e.g. Smith–Jones Wedding"></div>
    <div class="field"><label>Subtitle</label><input class="inp" data-chart-field="subtitle" value="${esc(c.subtitle)}" placeholder="e.g. Saturday, June 14 · Grand Ballroom"></div>
    <div class="field"><label>Paper size</label><select class="inp" data-chart-field="paper">${Object.entries(PAPERS).map(([k, p]) => `<option value="${k}" ${c.paper === k ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div>
    <div class="field"><span class="lbl">Orientation</span><div class="seg"><button data-orient="portrait" class="${c.orient === 'portrait' ? 'on' : ''}">Portrait</button><button data-orient="landscape" class="${c.orient === 'landscape' ? 'on' : ''}">Landscape</button></div></div>
    <hr class="divider">
    <div class="stats"><div class="stat"><b>${st.tables}</b><span>Tables</span></div><div class="stat"><b>${st.seats}</b><span>Seats</span></div><div class="stat"><b>${st.seats - st.filled}</b><span>Open</span></div></div>
    <div class="field"><span class="lbl">${st.filled} guests seated · ${pct}%</span><div class="meter"><i style="width:${pct}%"></i></div></div>
    ${guests.length ? `<div class="field"><span class="lbl">Guest list</span><div class="guest-list">${guests.map(g => `<div data-goto="${g.id}" data-i="${g.i}"><span>${esc(g.name)}</span><span>${esc(g.where)}</span></div>`).join('')}</div></div>`
      : `<p class="muted">Add a table from the left panel, then select it to enter guest names. Select nothing to return to these chart settings.</p>`}
    <hr class="divider">
    <div class="btn-row"><button class="btn sm" data-act="dup-chart">Duplicate chart</button><button class="btn sm danger" data-act="del-chart">Delete chart</button></div>
  </div>`;
}

function renderAll() { renderCanvas(); renderSidebar(); renderInspector(); updateUndoButtons(); }

/* ---------------- Adding items ---------------- */
function nextTableNumber() {
  let max = 0;
  chart().items.forEach(it => { const m = /(\d+)\s*$/.exec(it.label || ''); if (m && (it.type === 'round' || it.type === 'rect')) max = Math.max(max, +m[1]); });
  return max + 1;
}
function freeSpot(it) {
  const [W, H] = paperDims(chart());
  const cx = W / 2, cy = H / 2 + 0.2;
  const others = chart().items.map(bbox);
  const overlaps = b => others.some(o => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);
  const step = 0.25;
  for (let ring = 0; ring < 40; ring++) {
    for (let k = 0; k < Math.max(1, ring * 8); k++) {
      const a = (k / Math.max(1, ring * 8)) * Math.PI * 2;
      it.x = snap(cx + Math.cos(a) * ring * step); it.y = snap(cy + Math.sin(a) * ring * step);
      const b = bbox(it);
      if (b.x1 >= MARGIN && b.y1 >= MARGIN && b.x2 <= W - MARGIN && b.y2 <= H - MARGIN && !overlaps(b)) return;
    }
  }
  it.x = snap(cx); it.y = snap(cy);
}
function addItem(type) {
  const it = { id: uid(), type, x: 0, y: 0, rot: 0 };
  if (type === 'rect') { it.label = 'Table ' + nextTableNumber(); it.seats = Array(8).fill(''); it.ends = false; }
  if (type === 'row') { it.label = ''; it.seats = Array(6).fill(''); }
  if (type === 'seat') { it.seats = ['']; }
  if (type === 'area') { it.label = 'Stage'; it.w = 3; it.h = 1.25; }
  if (type === 'text') { it.text = 'Label'; it.size = 18; it.bold = true; }
  freeSpot(it);
  mutate(() => { chart().items.push(it); sel = it.id; });
}
function keepOnPage(it) {
  const [W, H] = paperDims(chart()), b = bbox(it);
  if (b.x2 - b.x1 < W) { if (b.x1 < 0) it.x = r3(it.x - b.x1); else if (b.x2 > W) it.x = r3(it.x - (b.x2 - W)); }
  if (b.y2 - b.y1 < H) { if (b.y1 < 0) it.y = r3(it.y - b.y1); else if (b.y2 > H) it.y = r3(it.y - (b.y2 - H)); }
}
const snap = v => snapOn ? Math.round(v / SNAP) * SNAP : r3(v);

/* ---------------- Canvas interaction ---------------- */
let drag = null;
function svgPoint(e) {
  const svg = $('#paper-wrap svg');
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}
$('#paper-wrap').addEventListener('pointerdown', e => {
  const g = e.target.closest('.item');
  if (!g) {
    if (e.target.closest('svg')) { if (sel) { sel = null; renderCanvas(); renderInspector(); } }
    return;
  }
  e.preventDefault();
  const id = g.dataset.id, it = findItem(id);
  const changed = sel !== id;
  sel = id;
  const p = svgPoint(e);
  drag = { id, sx: p.x, sy: p.y, ox: it.x, oy: it.y, moved: false, pre: JSON.stringify(state), pointer: e.pointerId };
  if (changed) { renderCanvas(); renderInspector(); }
  const seatIdx = e.target.dataset.seat;
  if (seatIdx !== undefined) highlightSeatRow(+seatIdx, false);
});
window.addEventListener('pointermove', e => {
  if (!drag) return;
  const it = findItem(drag.id); if (!it) return;
  const p = svgPoint(e);
  const dx = p.x - drag.sx, dy = p.y - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 0.04) return;
  if (!drag.moved) { drag.moved = true; undoStack.push(drag.pre); redoStack = []; updateUndoButtons(); }
  it.x = snap(drag.ox + dx); it.y = snap(drag.oy + dy);
  keepOnPage(it);
  renderCanvas();
});
window.addEventListener('pointerup', () => {
  if (!drag) return;
  if (drag.moved) save();
  drag = null;
});
$('#paper-wrap').addEventListener('dblclick', e => {
  const c = e.target.closest('.seat-c');
  const g = e.target.closest('.item');
  if (c) highlightSeatRow(+c.dataset.seat, true);
  else if (g) { const inp = $('#inspector [data-field="label"], #inspector [data-field="text"]'); if (inp) { inp.focus(); inp.select(); } }
});
function highlightSeatRow(i, focus) {
  const row = $(`#inspector [data-row="${i}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 900);
  if (focus) { const inp = row.querySelector('input'); inp.focus(); inp.select(); }
}

/* ---------------- Inspector events ---------------- */
const insp = $('#inspector');
let editSnap = false;
insp.addEventListener('focusin', e => { if (e.target.matches('input[type=text], input:not([type]), input[type=number]')) editSnap = false; });
function editOnce() { if (!editSnap) { snapshot(); editSnap = true; } }

insp.addEventListener('input', e => {
  const t = e.target;
  const it = sel && findItem(sel);
  if (t.dataset.chartField) {
    const f = t.dataset.chartField;
    if (f === 'paper') return; // handled on change
    editOnce(); chart()[f] = t.value; save(); renderCanvas(); renderSidebar();
    if (f === 'name') $('#inspector h2').textContent = t.value || 'Untitled';
    return;
  }
  if (!it) return;
  if (t.dataset.seatName !== undefined) {
    editOnce();
    const i = +t.dataset.seatName;
    it.seats[i] = t.value;
    t.closest('.seat-row').classList.toggle('filled', !!t.value.trim());
    const cnt = $('#inspector .seat-count');
    if (cnt) cnt.textContent = `· ${it.seats.filter(x => (x || '').trim()).length} of ${it.seats.length} seated`;
    save(); renderCanvas(); renderSidebar();
    return;
  }
  const f = t.dataset.field;
  if (!f) return;
  if (f === 'rot') {
    editOnce(); it.rot = +t.value; t.nextElementSibling.textContent = t.value + '°'; save(); renderCanvas(); return;
  }
  if (f === 'label' || f === 'text') {
    editOnce(); it[f] = t.value; $('#inspector h2').textContent = itemDisplayName(it); save(); renderCanvas(); return;
  }
  if (f === 'w' || f === 'h') {
    const v = parseFloat(t.value); if (!(v > 0)) return;
    editOnce(); it[f] = clamp(v, 0.25, 30); save(); renderCanvas(); return;
  }
  if (f === 'size') { const v = parseInt(t.value, 10); if (!(v > 0)) return; editOnce(); it.size = clamp(v, 6, 96); save(); renderCanvas(); return; }
  if (f === 'count') { const v = parseInt(t.value, 10); if (!(v >= 1)) return; editOnce(); setSeatCount(it, v, false); return; }
});
insp.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.chartField === 'paper') { mutate(() => { chart().paper = t.value; }); fitZoom(); return; }
  const it = sel && findItem(sel);
  if (!it) return;
  if (t.dataset.field === 'ends') mutate(() => { it.ends = t.checked; });
  if (t.dataset.field === 'bold') mutate(() => { it.bold = t.checked; });
  if (t.dataset.field === 'count') renderInspector();
  editSnap = false;
});
insp.addEventListener('click', e => {
  const b = e.target.closest('button, [data-goto]');
  if (!b) return;
  const it = sel && findItem(sel);
  if (b.dataset.step) {
    const f = b.dataset.step, d = +b.dataset.d;
    if (f === 'count') { mutate(() => setSeatCount(it, it.seats.length + d, true)); }
    if (f === 'size') { mutate(() => { it.size = clamp((it.size || 18) + d * 2, 6, 96); }); }
    return;
  }
  if (b.dataset.orient) { mutate(() => { chart().orient = b.dataset.orient; }); fitZoom(); return; }
  if (b.dataset.goto) {
    sel = b.dataset.goto; renderCanvas(); renderInspector(); highlightSeatRow(+b.dataset.i, true); return;
  }
  switch (b.dataset.act) {
    case 'dup': duplicateSel(); break;
    case 'del': deleteSel(); break;
    case 'clear-item': if (confirm('Clear all guest names at this table?')) mutate(() => { it.seats = it.seats.map(() => ''); }); break;
    case 'dup-chart': {
      const c = JSON.parse(JSON.stringify(chart()));
      c.id = uid(); c.name = (c.name || 'Chart') + ' (copy)';
      c.items.forEach(i => { i.id = uid(); });
      mutate(() => { state.charts.push(c); state.currentId = c.id; sel = null; });
      fitZoom();
      break;
    }
    case 'del-chart': {
      if (state.charts.length === 1) { alert('You need at least one chart. Create another chart first, or clear this one.'); break; }
      if (!confirm(`Delete “${chart().name}”? You can undo this with Ctrl+Z.`)) break;
      mutate(() => { const i = state.charts.indexOf(chart()); state.charts.splice(i, 1); state.currentId = state.charts[Math.max(0, i - 1)].id; sel = null; });
      fitZoom();
      break;
    }
  }
});
function setSeatCount(it, n, rerenderInsp) {
  n = clamp(n, 1, it.type === 'row' ? 40 : 30);
  const s = it.seats.slice(0, n);
  while (s.length < n) s.push('');
  it.seats = s;
  save(); renderCanvas(); renderSidebar();
  if (rerenderInsp) renderInspector();
}
function duplicateSel() {
  const it = sel && findItem(sel); if (!it) return;
  const c = JSON.parse(JSON.stringify(it));
  c.id = uid(); c.x = snap(it.x + 0.5); c.y = snap(it.y + 0.5);
  if (c.seats) c.seats = c.seats.map(() => '');
  if ((c.type === 'round' || c.type === 'rect') && /\d+\s*$/.test(c.label || '')) c.label = c.label.replace(/\d+\s*$/, String(nextTableNumber()));
  mutate(() => { chart().items.push(c); sel = c.id; });
}
function deleteSel() {
  if (!sel) return;
  mutate(() => { chart().items = chart().items.filter(i => i.id !== sel); sel = null; });
}

/* ---------------- Sidebar & toolbar ---------------- */
$('#chart-list').addEventListener('click', e => {
  const li = e.target.closest('[data-chart]'); if (!li) return;
  if (state.currentId === li.dataset.chart) { sel = null; renderAll(); return; }
  state.currentId = li.dataset.chart; sel = null; save(); renderAll(); fitZoom();
});
$('#btn-new-chart').addEventListener('click', () => {
  const c = newChart('Seating Chart ' + (state.charts.length + 1));
  mutate(() => { state.charts.push(c); state.currentId = c.id; sel = null; });
  fitZoom();
  setTimeout(() => { const i = $('[data-chart-field="name"]'); if (i) { i.focus(); i.select(); } }, 0);
});
$$('.palette [data-add]').forEach(b => b.addEventListener('click', () => addItem(b.dataset.add)));
$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-zoom-in').addEventListener('click', () => setZoom(zoom * 1.2));
$('#btn-zoom-out').addEventListener('click', () => setZoom(zoom / 1.2));
$('#btn-zoom-fit').addEventListener('click', fitZoom);
$('#btn-grid').addEventListener('click', () => { snapOn = !snapOn; $('#btn-grid').classList.toggle('on', snapOn); renderCanvas(); });
$('#btn-grid').classList.toggle('on', snapOn);
$('#search').addEventListener('input', e => { search = e.target.value; renderCanvas(); });
$('#search').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const q = search.trim().toLowerCase(); if (!q) return;
  for (const it of chart().items) {
    const i = (it.seats || []).findIndex(n => (n || '').toLowerCase().includes(q));
    if (i >= 0) { sel = it.id; renderCanvas(); renderInspector(); highlightSeatRow(i, false); return; }
  }
  for (const c of state.charts) {
    if (c.items.some(it => (it.seats || []).some(n => (n || '').toLowerCase().includes(q)))) { state.currentId = c.id; sel = null; renderAll(); return; }
  }
});

function setZoom(z) {
  const stage = $('#stage');
  const cx = (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth;
  const cy = (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight;
  zoom = clamp(z, 0.25, 4);
  renderCanvas();
  stage.scrollLeft = cx * stage.scrollWidth - stage.clientWidth / 2;
  stage.scrollTop = cy * stage.scrollHeight - stage.clientHeight / 2;
}
function fitZoom() {
  const stage = $('#stage');
  const [W, H] = paperDims(chart());
  const z = Math.min((stage.clientWidth - 80) / (W * PX), (stage.clientHeight - 80) / (H * PX));
  zoom = clamp(Math.floor(z * 20) / 20, 0.25, 4);
  renderCanvas();
}
$('#stage').addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });
window.addEventListener('resize', () => { clearTimeout(window.__rz); window.__rz = setTimeout(fitZoom, 150); });

/* File menu */
const menu = $('#menu-more');
$('#btn-more').addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; });
document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) menu.hidden = true; });
menu.addEventListener('click', e => {
  const a = e.target.dataset.act; if (!a) return;
  menu.hidden = true;
  if (a === 'export') {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `seating-charts-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (a === 'import') $('#import-file').click();
  if (a === 'logout') { pushToServer().finally(() => { location.href = '/logout'; }); }
  if (a === 'clear-names') {
    if (confirm(`Clear every guest name in “${chart().name}”? You can undo this.`)) mutate(() => chart().items.forEach(it => { if (it.seats) it.seats = it.seats.map(() => ''); }));
  }
});
$('#import-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data || !Array.isArray(data.charts) || !data.charts.length) throw new Error('bad');
    const replace = confirm('Replace your current charts with the imported ones?\n\nOK = replace · Cancel = add them alongside your current charts');
    mutate(() => {
      if (replace) state = data;
      else {
        data.charts.forEach(c => { c.id = uid(); state.charts.push(c); });
        state.currentId = state.charts[state.charts.length - 1].id;
      }
      sel = null;
    });
    fitZoom();
  } catch (err) { alert('That file could not be read as a seating chart backup.'); }
  e.target.value = '';
});

/* Keyboard */
document.addEventListener('keydown', e => {
  const inField = e.target.matches('input, textarea, select');
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y' && !inField) { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); openPrint(); return; }
  if (inField) { if (e.key === 'Escape') e.target.blur(); if (e.key === 'Enter' && e.target.dataset.seatName !== undefined) { const n = $(`#inspector [data-seat-name="${+e.target.dataset.seatName + 1}"]`); if (n) { n.focus(); n.select(); } else e.target.blur(); } return; }
  if (!$('#print-modal').hidden) { if (e.key === 'Escape') closePrint(); return; }
  const it = sel && findItem(sel);
  if (e.key === 'Escape') { sel = null; renderCanvas(); renderInspector(); return; }
  if (!it) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSel(); return; }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSel(); return; }
  if (e.key.toLowerCase() === 'r' && !mod && it.type !== 'round' && it.type !== 'seat') { mutate(() => { it.rot = ((it.rot || 0) + (e.shiftKey ? 345 : 15)) % 360; }); return; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key]) {
    e.preventDefault();
    const d = e.shiftKey ? 0.5 : SNAP;
    mutate(() => { it.x = r3(it.x + arrows[e.key][0] * d); it.y = r3(it.y + arrows[e.key][1] * d); keepOnPage(it); }, { inspector: false });
  }
});

/* ---------------- Printing ---------------- */
function guestIndexHTML(c) {
  const guests = [];
  c.items.forEach(it => (it.seats || []).forEach(n => { if ((n || '').trim()) guests.push({ name: n.trim(), where: itemDisplayName(it) }); }));
  const lastKey = n => { const p = n.split(/\s+/); return (p.length > 1 ? p[p.length - 1] + ' ' + p.slice(0, -1).join(' ') : n).toLowerCase(); };
  guests.sort((a, b) => lastKey(a.name).localeCompare(lastKey(b.name)));
  let letter = '', rows = '';
  guests.forEach(g => {
    const L = lastKey(g.name)[0].toUpperCase();
    if (L !== letter) { letter = L; rows += `<div class="letter"><span>${esc(L)}</span></div>`; }
    rows += `<div><span>${esc(g.name)}</span><span>${esc(g.where)}</span></div>`;
  });
  return `<div class="gi"><h1>${esc(c.title || c.name)} — Guest List</h1><p class="sub">${esc(c.subtitle || '')}${c.subtitle ? ' · ' : ''}${guests.length} guests, sorted by last name</p><hr class="rule"><div class="cols">${rows || '<p>No guests entered yet.</p>'}</div></div>`;
}
function buildPrint(which, withIndex) {
  const charts = which === 'all' ? state.charts : [chart()];
  let css = '@page { margin: 0; }', html = '';
  const seen = new Set();
  charts.forEach(c => {
    const [w, h] = paperDims(c);
    const pn = ('p' + w + 'x' + h).replace(/\./g, '_');
    if (!seen.has(pn)) { css += `@page ${pn} { size: ${w}in ${h}in; margin: 0; }`; seen.add(pn); }
    const style = `page:${pn};width:${w}in;height:${r3(h - 0.02)}in`;
    html += `<div class="print-page" style="${style}">${chartSVG(c, { print: true })}</div>`;
    if (withIndex) html += `<div class="print-page" style="${style}">${guestIndexHTML(c)}</div>`;
  });
  // Fallback page size for browsers without named pages
  const [fw, fh] = paperDims(charts[0]);
  css = `@page { size: ${fw}in ${fh}in; margin: 0; }` + css;
  $('#print-style').textContent = `@media print { ${css} }`;
  $('#print-root').innerHTML = html;
}
function openPrint() {
  $('#print-count').textContent = `(${state.charts.length})`;
  $('#print-modal').hidden = false;
  $('#print-go').focus();
}
function closePrint() { $('#print-modal').hidden = true; }
$('#btn-print').addEventListener('click', openPrint);
$('#print-cancel').addEventListener('click', closePrint);
$('#print-modal').addEventListener('click', e => { if (e.target.id === 'print-modal') closePrint(); });
$('#print-go').addEventListener('click', () => {
  const which = $('input[name="print-which"]:checked').value;
  buildPrint(which, $('#print-index').checked);
  closePrint();
  setTimeout(() => window.print(), 50);
});
window.addEventListener('beforeprint', () => { if (!$('#print-root').innerHTML) buildPrint('current', false); });
window.addEventListener('afterprint', () => { $('#print-root').innerHTML = ''; });

/* ---------------- Boot ---------------- */
function starterLayout() {
  const c = chart();
  c.title = 'Seating Chart';
  const [W] = paperDims(c);
  c.items.push({ id: uid(), type: 'area', x: W / 2, y: 1.75, rot: 0, label: 'Head Table Area', w: 4.5, h: 0.6 });
  [[W / 2 - 3, 3.9], [W / 2, 3.9], [W / 2 + 3, 3.9], [W / 2 - 1.5, 6.3], [W / 2 + 1.5, 6.3]].forEach(([x, y], i) => {
    c.items.push({ id: uid(), type: 'rect', x, y, rot: 0, label: 'Table ' + (i + 1), seats: Array(8).fill(''), ends: false });
  });
}
async function boot() {
  const hadLocal = !!localStorage.getItem(STORE);
  renderAll();
  requestAnimationFrame(fitZoom);
  setStatus('Loading…');
  try {
    const res = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) { location.href = '/'; return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.state && Array.isArray(data.state.charts) && data.state.charts.length) {
      state = migrate(data.state);
      if (!state.charts.some(c => c.id === state.currentId)) state.currentId = state.charts[0].id;
      try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* ignore */ }
      sel = null; undoStack = []; redoStack = [];
      renderAll(); fitZoom();
      setStatus('All changes saved', 'ok');
    } else {
      // Nothing on the server yet: upload what this browser has (or a starter layout).
      if (!hadLocal) { starterLayout(); renderAll(); }
      save();
    }
  } catch (e) {
    setStatus('Offline — changes kept on this device', 'warn');
    if (!hadLocal) { starterLayout(); renderAll(); }
  }
}
boot();
