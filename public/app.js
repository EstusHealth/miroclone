(() => {
  'use strict';

  const STICKY_COLORS = ['#fde68a', '#fdba74', '#f9a8d4', '#c4b5fd', '#93c5fd', '#86efac', '#e5e7eb'];
  const INK_COLORS = ['#1f2330', '#ef4444', '#f59e0b', '#ec4899', '#8b5cf6', '#3b82f6', '#10b981'];
  const USER_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
  const DEFAULT_SIZE = { sticky: [200, 200], text: [260, 40], rect: [200, 130], ellipse: [180, 130] };
  const MIN_SIZE = { sticky: [60, 60], text: [40, 28], rect: [20, 20], ellipse: [20, 20] };
  const GRID = 22;
  const paletteFor = (type) => (type === 'sticky' ? STICKY_COLORS : INK_COLORS);

  const $ = (sel) => document.querySelector(sel);
  const match = location.pathname.match(/^\/b\/([A-Za-z0-9_-]{4,64})\/?$/);
  if (!match) {
    $('#landing').hidden = false;
    return;
  }
  const roomId = match[1];
  $('#board').hidden = false;

  const canvas = $('#canvas');
  const world = $('#world');
  const marquee = $('#marquee');
  const cursorsLayer = $('#cursors');
  const contextbar = $('#contextbar');
  const swatchesEl = $('#swatches');

  // ---------- State ----------
  const items = new Map(); // id -> item
  const els = new Map(); // id -> element
  const users = new Map(); // id -> { name, color, x, y, el, idleTimer }
  let selected = new Set();
  let editingId = null;
  let tool = 'select';
  let colorIndex = 0;
  let maxZ = 0;
  let spaceDown = false;
  const view = { x: 0, y: 0, z: 1 };

  const me = loadIdentity();

  const PLAINTEXT_EDITABLE = (() => {
    try {
      const d = document.createElement('div');
      d.contentEditable = 'plaintext-only';
      return d.contentEditable === 'plaintext-only';
    } catch { return false; }
  })();

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function loadIdentity() {
    const adjectives = ['Swift', 'Calm', 'Bright', 'Bold', 'Clever', 'Happy', 'Brave', 'Witty', 'Sunny', 'Quiet'];
    const animals = ['Otter', 'Fox', 'Panda', 'Koala', 'Falcon', 'Lynx', 'Heron', 'Badger', 'Gecko', 'Moose'];
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('liveboard:me')); } catch {}
    if (saved && saved.name && saved.color) return saved;
    const fresh = { name: `${pick(adjectives)} ${pick(animals)}`, color: pick(USER_COLORS) };
    saveIdentity(fresh);
    return fresh;
  }

  function saveIdentity(id) {
    try { localStorage.setItem('liveboard:me', JSON.stringify(id)); } catch {}
  }

  // ---------- Networking ----------
  let ws = null;
  let retry = 0;
  const pending = new Map();
  let flushTimer = null;
  let lastCursorSent = 0;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(roomId)}`);
    setStatus(retry ? 'Reconnecting…' : 'Connecting…', 'connecting');
    ws.onopen = () => {
      retry = 0;
      setStatus('Live', 'live');
      send({ t: 'hello', name: me.name, color: me.color });
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleMessage(msg);
    };
    ws.onclose = () => {
      setStatus('Offline, retrying…', 'offline');
      for (const id of [...users.keys()]) removeUser(id);
      setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function queueUpsert(item) {
    pending.set(item.id, item);
    if (!flushTimer) flushTimer = setTimeout(flush, 40);
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!pending.size) return;
    send({ t: 'upsert', items: [...pending.values()] });
    pending.clear();
  }

  function handleMessage(msg) {
    switch (msg.t) {
      case 'init': {
        for (const u of msg.users) upsertUser(u);
        if (!msg.items.length && items.size) {
          // The server forgot the board (e.g. it restarted) but we still have it: hand it back.
          send({ t: 'upsert', items: [...items.values()] });
        } else {
          for (const id of [...items.keys()]) removeItem(id);
          for (const item of msg.items) applyRemoteItem(item);
        }
        renderPeople();
        break;
      }
      case 'join':
        upsertUser(msg.user);
        renderPeople();
        break;
      case 'leave':
        removeUser(msg.id);
        renderPeople();
        break;
      case 'cursor':
        moveCursor(msg.id, msg.x, msg.y);
        break;
      case 'upsert':
        for (const item of msg.items) applyRemoteItem(item);
        updateContextbar();
        break;
      case 'delete':
        for (const id of msg.ids) removeItem(id);
        updateContextbar();
        break;
      case 'clear':
        for (const id of [...items.keys()]) removeItem(id);
        updateContextbar();
        break;
    }
  }

  function applyRemoteItem(item) {
    if (!item || typeof item.id !== 'string') return;
    const local = items.get(item.id);
    // Keep what we're typing; only take position/size/colour from the remote copy.
    if (local && editingId === item.id) item.text = local.text;
    items.set(item.id, item);
    maxZ = Math.max(maxZ, item.z || 0);
    render(item);
  }

  // ---------- Presence ----------
  function upsertUser(u) {
    const existing = users.get(u.id);
    if (existing) {
      existing.name = u.name;
      existing.color = u.color;
      if (existing.el) styleCursor(existing);
    } else {
      users.set(u.id, { id: u.id, name: u.name, color: u.color, x: 0, y: 0, el: null, idleTimer: null });
    }
  }

  function removeUser(id) {
    const u = users.get(id);
    if (!u) return;
    if (u.el) u.el.remove();
    clearTimeout(u.idleTimer);
    users.delete(id);
  }

  function styleCursor(u) {
    u.el.querySelector('path').setAttribute('fill', u.color);
    const label = u.el.querySelector('span');
    label.textContent = u.name;
    label.style.background = u.color;
  }

  function moveCursor(id, x, y) {
    const u = users.get(id);
    if (!u) return;
    if (!u.el) {
      u.el = document.createElement('div');
      u.el.className = 'cursor';
      u.el.innerHTML = '<svg viewBox="0 0 18 18"><path d="M1 1l6 15 2.2-6.3L16 7.5z" stroke="#fff" stroke-width="1.2"/></svg><span></span>';
      cursorsLayer.appendChild(u.el);
      styleCursor(u);
    }
    u.x = x;
    u.y = y;
    u.el.style.opacity = 1;
    positionCursor(u);
    clearTimeout(u.idleTimer);
    u.idleTimer = setTimeout(() => { if (u.el) u.el.style.opacity = 0; }, 10000);
  }

  function positionCursor(u) {
    u.el.style.transform = `translate(${u.x * view.z + view.x}px, ${u.y * view.z + view.y}px)`;
  }

  function initials(name) {
    return name.split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
  }

  function renderPeople() {
    const people = $('#people');
    people.innerHTML = '';
    const avatar = (u, isMe) => {
      const a = document.createElement('div');
      a.className = 'avatar' + (isMe ? ' me' : '');
      a.style.background = u.color;
      a.textContent = initials(u.name);
      a.title = isMe ? `${u.name} (you) · click to rename` : u.name;
      return a;
    };
    const mine = avatar(me, true);
    mine.addEventListener('click', rename);
    people.appendChild(mine);
    const others = [...users.values()];
    for (const u of others.slice(0, 5)) people.appendChild(avatar(u, false));
    if (others.length > 5) {
      const more = document.createElement('div');
      more.className = 'avatar more';
      more.textContent = `+${others.length - 5}`;
      more.title = others.slice(5).map((u) => u.name).join(', ');
      people.appendChild(more);
    }
  }

  function rename() {
    const name = prompt('Your name', me.name);
    if (!name || !name.trim()) return;
    me.name = name.trim().slice(0, 32);
    saveIdentity(me);
    send({ t: 'hello', name: me.name, color: me.color });
    renderPeople();
  }

  function setStatus(text, state) {
    const el = $('#status');
    el.textContent = text;
    el.dataset.state = state;
  }

  // ---------- View ----------
  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    canvas.style.backgroundSize = `${GRID * view.z}px ${GRID * view.z}px`;
    canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
    $('#zoom-reset').textContent = `${Math.round(view.z * 100)}%`;
    for (const u of users.values()) if (u.el) positionCursor(u);
  }

  function zoomAt(sx, sy, factor) {
    const rect = canvas.getBoundingClientRect();
    const cx = sx - rect.left;
    const cy = sy - rect.top;
    const z = Math.min(4, Math.max(0.1, view.z * factor));
    view.x = cx - (cx - view.x) * (z / view.z);
    view.y = cy - (cy - view.y) * (z / view.z);
    view.z = z;
    applyView();
  }

  function zoomCenter(factor) {
    const rect = canvas.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  function toWorld(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left - view.x) / view.z, y: (e.clientY - rect.top - view.y) / view.z };
  }

  // ---------- Rendering ----------
  function penPath(points) {
    if (!points || !points.length) return '';
    const [x0, y0] = points[0];
    if (points.length === 1) return `M${x0} ${y0}l0.01 0`;
    let d = `M${x0} ${y0}`;
    for (let i = 1; i < points.length - 1; i++) {
      const [x, y] = points[i];
      const [nx, ny] = points[i + 1];
      d += `Q${x} ${y} ${((x + nx) / 2).toFixed(1)} ${((y + ny) / 2).toFixed(1)}`;
    }
    const [lx, ly] = points[points.length - 1];
    return d + `L${lx} ${ly}`;
  }

  function buildElement(item) {
    const el = document.createElement('div');
    el.dataset.id = item.id;
    if (item.type === 'pen') {
      el.innerHTML = '<svg><path class="hit"/><path class="ink"/></svg>';
    } else {
      if (item.type === 'rect' || item.type === 'ellipse') {
        const shape = document.createElement('div');
        shape.className = 'shape';
        el.appendChild(shape);
      }
      const text = document.createElement('div');
      text.className = 'text';
      text.addEventListener('input', () => {
        const it = items.get(item.id);
        if (!it) return;
        it.text = text.innerText;
        queueUpsert(it);
      });
      text.addEventListener('blur', () => {
        if (editingId === item.id) stopEditing();
      });
      el.appendChild(text);
      const handle = document.createElement('div');
      handle.className = 'handle';
      el.appendChild(handle);
    }
    world.appendChild(el);
    els.set(item.id, el);
    return el;
  }

  function render(item) {
    const el = els.get(item.id) || buildElement(item);
    const isSel = selected.has(item.id);
    el.className = `item ${item.type}` +
      (isSel ? ' selected' : '') +
      (isSel && selected.size === 1 ? ' single' : '') +
      (editingId === item.id ? ' editing' : '');
    el.style.left = `${item.x}px`;
    el.style.top = `${item.y}px`;
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    el.style.zIndex = item.z || 0;

    if (item.type === 'pen') {
      const d = penPath(item.points);
      for (const p of el.querySelectorAll('path')) p.setAttribute('d', d);
      el.querySelector('.ink').style.stroke = item.color;
      return;
    }
    const text = el.querySelector('.text');
    if (item.type === 'sticky') el.style.background = item.color;
    if (item.type === 'text') text.style.color = item.color;
    if (item.type === 'rect' || item.type === 'ellipse') el.querySelector('.shape').style.color = item.color;
    if (editingId !== item.id && text.textContent !== (item.text || '')) text.textContent = item.text || '';
  }

  function removeItem(id) {
    if (editingId === id) editingId = null;
    const el = els.get(id);
    if (el) el.remove();
    els.delete(id);
    items.delete(id);
    selected.delete(id);
    pending.delete(id);
  }

  // ---------- Selection & editing ----------
  function setSelection(ids) {
    const prev = selected;
    selected = new Set(ids);
    for (const id of new Set([...prev, ...selected])) {
      const item = items.get(id);
      if (item) render(item);
    }
    updateContextbar();
  }

  function startEditing(id) {
    const item = items.get(id);
    if (!item || item.type === 'pen') return;
    editingId = id;
    setSelection([id]);
    const text = els.get(id).querySelector('.text');
    text.contentEditable = PLAINTEXT_EDITABLE ? 'plaintext-only' : 'true';
    render(item);
    text.focus();
    const range = document.createRange();
    range.selectNodeContents(text);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function stopEditing() {
    if (!editingId) return;
    const id = editingId;
    editingId = null;
    const el = els.get(id);
    if (el) el.querySelector('.text').contentEditable = 'false';
    window.getSelection().removeAllRanges();
    const item = items.get(id);
    if (!item) return;
    if (item.type === 'text' && !(item.text || '').trim()) {
      deleteItems([id]);
    } else {
      render(item);
    }
    flush();
  }

  // ---------- Item operations ----------
  function createItem(type, x, y, extra = {}) {
    const [w, h] = DEFAULT_SIZE[type] || [1, 1];
    const item = {
      id: uid(), type,
      x: Math.round(x), y: Math.round(y), w, h,
      color: paletteFor(type)[colorIndex],
      text: '', z: ++maxZ,
      ...extra,
    };
    items.set(item.id, item);
    render(item);
    queueUpsert(item);
    return item;
  }

  function deleteItems(ids) {
    if (!ids.length) return;
    for (const id of ids) removeItem(id);
    send({ t: 'delete', ids });
    updateContextbar();
  }

  function duplicateSelected() {
    const copies = [...selected]
      .map((id) => items.get(id))
      .sort((a, b) => a.z - b.z)
      .map((it) => {
        const copy = { ...JSON.parse(JSON.stringify(it)), id: uid(), x: it.x + 24, y: it.y + 24, z: ++maxZ };
        items.set(copy.id, copy);
        render(copy);
        queueUpsert(copy);
        return copy.id;
      });
    setSelection(copies);
  }

  function bringToFront() {
    for (const it of [...selected].map((id) => items.get(id)).sort((a, b) => a.z - b.z)) {
      it.z = ++maxZ;
      render(it);
      queueUpsert(it);
    }
  }

  function setTool(next) {
    if (editingId) stopEditing();
    tool = next;
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
    canvas.className = `tool-${tool}`;
    if (tool !== 'select') setSelection([]);
    updateContextbar();
  }

  function updateContextbar() {
    const sel = [...selected].map((id) => items.get(id)).filter(Boolean);
    const creating = !['select', 'hand'].includes(tool);
    if (!sel.length && !creating) {
      contextbar.hidden = true;
      return;
    }
    contextbar.hidden = false;
    contextbar.classList.toggle('tool-only', !sel.length);
    const type = sel.length ? sel[0].type : tool;
    const palette = paletteFor(type);
    const active = sel.length ? palette.indexOf(sel[0].color) : colorIndex;
    swatchesEl.innerHTML = '';
    palette.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (i === active ? ' active' : '');
      b.style.background = c;
      b.title = 'Colour';
      b.addEventListener('click', () => {
        colorIndex = i;
        for (const it of sel) {
          it.color = paletteFor(it.type)[i];
          render(it);
          queueUpsert(it);
        }
        updateContextbar();
      });
      swatchesEl.appendChild(b);
    });
  }

  // ---------- Pointer interaction ----------
  function drag(e, onMove, onUp) {
    canvas.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      if (onUp) onUp(ev);
      flush();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  function startPan(e) {
    const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
    canvas.classList.add('panning');
    drag(e, (ev) => {
      view.x = ox + ev.clientX - sx;
      view.y = oy + ev.clientY - sy;
      applyView();
    }, () => canvas.classList.remove('panning'));
  }

  function startMove(e) {
    const start = toWorld(e);
    const origins = [...selected].map((id) => items.get(id)).filter(Boolean).map((it) => ({ it, x: it.x, y: it.y }));
    let moved = false;
    drag(e, (ev) => {
      const p = toWorld(ev);
      const dx = p.x - start.x, dy = p.y - start.y;
      if (!moved && Math.hypot(dx, dy) * view.z < 3) return;
      moved = true;
      for (const o of origins) {
        o.it.x = Math.round(o.x + dx);
        o.it.y = Math.round(o.y + dy);
        render(o.it);
        queueUpsert(o.it);
      }
    });
  }

  function startResize(id, e) {
    const item = items.get(id);
    const start = toWorld(e);
    const ow = item.w, oh = item.h;
    const [minW, minH] = MIN_SIZE[item.type] || [20, 20];
    drag(e, (ev) => {
      const p = toWorld(ev);
      item.w = Math.round(Math.max(minW, ow + p.x - start.x));
      item.h = Math.round(Math.max(minH, oh + p.y - start.y));
      render(item);
      queueUpsert(item);
    });
  }

  function startShape(type, e) {
    const start = toWorld(e);
    let item = null;
    drag(e, (ev) => {
      const p = toWorld(ev);
      if (!item && Math.hypot(p.x - start.x, p.y - start.y) * view.z < 4) return;
      if (!item) item = createItem(type, start.x, start.y);
      item.x = Math.round(Math.min(start.x, p.x));
      item.y = Math.round(Math.min(start.y, p.y));
      item.w = Math.round(Math.max(10, Math.abs(p.x - start.x)));
      item.h = Math.round(Math.max(10, Math.abs(p.y - start.y)));
      render(item);
      queueUpsert(item);
    }, () => {
      if (!item) {
        const [w, h] = DEFAULT_SIZE[type];
        item = createItem(type, start.x - w / 2, start.y - h / 2);
      }
      setTool('select');
      setSelection([item.id]);
    });
  }

  function startPen(e) {
    const pts = [[toWorld(e).x, toWorld(e).y]];
    const item = createItem('pen', pts[0][0], pts[0][1], { w: 1, h: 1, points: [[0, 0]] });
    const update = () => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of pts) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      item.x = Math.round(minX);
      item.y = Math.round(minY);
      item.w = Math.max(1, Math.round(maxX - minX));
      item.h = Math.max(1, Math.round(maxY - minY));
      item.points = pts.map(([x, y]) => [+(x - item.x).toFixed(1), +(y - item.y).toFixed(1)]);
      render(item);
      queueUpsert(item);
    };
    drag(e, (ev) => {
      const p = toWorld(ev);
      const [lx, ly] = pts[pts.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) * view.z < 2) return;
      pts.push([p.x, p.y]);
      update();
    });
  }

  function startMarquee(e) {
    const rect = canvas.getBoundingClientRect();
    const start = toWorld(e);
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const base = e.shiftKey ? new Set(selected) : new Set();
    drag(e, (ev) => {
      const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
      Object.assign(marquee.style, {
        left: `${Math.min(sx, cx)}px`, top: `${Math.min(sy, cy)}px`,
        width: `${Math.abs(cx - sx)}px`, height: `${Math.abs(cy - sy)}px`,
      });
      marquee.hidden = false;
      const p = toWorld(ev);
      const x1 = Math.min(start.x, p.x), x2 = Math.max(start.x, p.x);
      const y1 = Math.min(start.y, p.y), y2 = Math.max(start.y, p.y);
      const hits = new Set(base);
      for (const it of items.values()) {
        if (it.x < x2 && it.x + it.w > x1 && it.y < y2 && it.y + it.h > y1) hits.add(it.id);
      }
      setSelection(hits);
    }, () => { marquee.hidden = true; });
  }

  let lastDown = { time: 0, id: null, x: 0, y: 0 };

  canvas.addEventListener('pointerdown', (e) => {
    const itemEl = e.target.closest('.item');
    const id = itemEl ? itemEl.dataset.id : null;

    // Leave clicks inside the text being edited to the browser (caret placement, selection).
    if (editingId && id === editingId) return;
    if (editingId) stopEditing();

    if (e.button === 1 || tool === 'hand' || spaceDown) {
      e.preventDefault();
      return startPan(e);
    }
    if (e.button !== 0) return;

    const now = performance.now();
    const isDouble = now - lastDown.time < 350 && lastDown.id === id &&
      Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 8;
    lastDown = { time: now, id, x: e.clientX, y: e.clientY };

    const p = toWorld(e);
    switch (tool) {
      case 'pen':
        return startPen(e);
      case 'sticky': {
        const [w, h] = DEFAULT_SIZE.sticky;
        const item = createItem('sticky', p.x - w / 2, p.y - h / 2);
        setTool('select');
        return startEditing(item.id);
      }
      case 'text': {
        const item = createItem('text', p.x, p.y - 18);
        setTool('select');
        return startEditing(item.id);
      }
      case 'rect':
      case 'ellipse':
        return startShape(tool, e);
    }

    // Select tool
    if (isDouble) {
      e.preventDefault();
      if (id) return startEditing(id);
      const [w, h] = DEFAULT_SIZE.sticky;
      return startEditing(createItem('sticky', p.x - w / 2, p.y - h / 2).id);
    }
    if (e.target.classList.contains('handle') && id) return startResize(id, e);
    if (id) {
      if (e.shiftKey) {
        const next = new Set(selected);
        next.has(id) ? next.delete(id) : next.add(id);
        return setSelection(next);
      }
      if (!selected.has(id)) setSelection([id]);
      return startMove(e);
    }
    // Empty canvas: touch pans, mouse draws a selection box.
    if (e.pointerType === 'touch') {
      setSelection([]);
      return startPan(e);
    }
    if (!e.shiftKey) setSelection([]);
    startMarquee(e);
  });

  // Stop the browser moving focus away from text we just started editing.
  canvas.addEventListener('mousedown', (e) => {
    const itemEl = e.target.closest('.item');
    if (!itemEl || itemEl.dataset.id !== editingId) e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - lastCursorSent < 40) return;
    lastCursorSent = now;
    const p = toWorld(e);
    send({ t: 'cursor', x: Math.round(p.x), y: Math.round(p.y) });
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
    } else {
      view.x -= e.deltaX;
      view.y -= e.deltaY;
      applyView();
    }
  }, { passive: false });

  // ---------- Keyboard ----------
  window.addEventListener('keydown', (e) => {
    if (e.target.isContentEditable || /INPUT|TEXTAREA/.test(e.target.tagName)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === ' ') {
      spaceDown = true;
      canvas.classList.add('panning-ready');
      e.preventDefault();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      deleteItems([...selected]);
    } else if (e.key === 'Escape') {
      setTool('select');
      setSelection([]);
    } else if (e.key === 'Enter' && selected.size === 1) {
      e.preventDefault();
      startEditing([...selected][0]);
    } else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelected();
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelection([...items.keys()]);
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      zoomCenter(1.2);
    } else if (mod && e.key === '-') {
      e.preventDefault();
      zoomCenter(1 / 1.2);
    } else if (!mod && !e.altKey) {
      const keyTools = { v: 'select', h: 'hand', n: 'sticky', t: 'text', r: 'rect', o: 'ellipse', p: 'pen' };
      const next = keyTools[e.key.toLowerCase()];
      if (next) setTool(next);
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceDown = false;
      canvas.classList.remove('panning-ready');
    }
  });

  // ---------- Chrome buttons ----------
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  }
  $('#zoom-in').addEventListener('click', () => zoomCenter(1.2));
  $('#zoom-out').addEventListener('click', () => zoomCenter(1 / 1.2));
  $('#zoom-reset').addEventListener('click', () => zoomCenter(1 / view.z));
  $('#delete').addEventListener('click', () => deleteItems([...selected]));
  $('#duplicate').addEventListener('click', duplicateSelected);
  $('#to-front').addEventListener('click', bringToFront);
  $('#clear').addEventListener('click', () => {
    if (!items.size || !confirm('Clear the whole board for everyone?')) return;
    for (const id of [...items.keys()]) removeItem(id);
    send({ t: 'clear' });
    updateContextbar();
  });

  let toastTimer = null;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  $('#share').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Link copied. Anyone with it can join this board.');
    } catch {
      prompt('Copy this link to share the board:', location.href);
    }
  });

  // ---------- Boot ----------
  const rect = canvas.getBoundingClientRect();
  view.x = Math.round(rect.width / 2);
  view.y = Math.round(rect.height / 2);
  applyView();
  renderPeople();
  setTool('select');
  connect();
})();
