/* CalText — content.js
 * Pure vanilla JS. No network requests. Everything client-side.
 */
(function CalText() {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────

  const S_SEL = 'cg_selections_v1';
  const S_SET = 'cg_settings_v1';

  const DEFAULTS = {
    format:    'ddd, MMM D [at] h:mm A',
    color:     '#4285f4',
    opacity:   0.35,
    increment: 30,
    bullets:   true,
  };

  // Matches tokens OR bracketed literals [like this]
  const TOKEN_RE  = /\[([^\]]*)\]|dddd|ddd|MMMM|MMM|MM|M|DD|D|YYYY|YY|hh|h|HH|H|mm|A|a/g;
  const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MON_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

  // Matches Google Calendar day column aria-labels:
  //   "Sunday, March 29"  or  "Tuesday, March 31, today"
  const COL_RE = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\w+ \d{1,2})(, today)?$/i;


  // ── State ──────────────────────────────────────────────────────────────────

  const S = {
    settings:  { ...DEFAULTS },
    selections: [],   // [{ date:'YYYY-MM-DD', startMin, endMin }]
    undoStack:  [],   // max 10
    drag:       null, // { mode:'add'|'remove', date, startMin, currentMin, block }
    modeOn:     false,
    collapsed:  true,
    cal: {
      scrollEl:    null,
      pxPerMinute: 0,
      dayCols:     [],  // [{ date, x, rect }] sorted by x
    },
    calibrated:  false,
    scrollRaf:   false,
  };


  // ── Persist ────────────────────────────────────────────────────────────────

  function loadState() {
    try {
      const sel = localStorage.getItem(S_SEL);
      const set = localStorage.getItem(S_SET);
      if (sel) S.selections = JSON.parse(sel);
      if (set) S.settings   = { ...DEFAULTS, ...JSON.parse(set) };
      sortSelections();
    } catch (_) {
      S.selections = [];
      S.settings   = { ...DEFAULTS };
    }
  }

  function saveSel() {
    try { localStorage.setItem(S_SEL, JSON.stringify(S.selections)); } catch (_) {}
  }
  function saveSet() {
    try { localStorage.setItem(S_SET, JSON.stringify(S.settings)); } catch (_) {}
  }


  // ── Geometry ───────────────────────────────────────────────────────────────

  function minuteToViewportY(minute) {
    const { scrollEl, pxPerMinute } = S.cal;
    if (!scrollEl) return 0;
    const r = scrollEl.getBoundingClientRect();
    return r.top + minute * pxPerMinute - scrollEl.scrollTop;
  }

  function viewportYToMinute(vy) {
    const { scrollEl, pxPerMinute } = S.cal;
    if (!scrollEl || !pxPerMinute) return 0;
    const r = scrollEl.getBoundingClientRect();
    return (vy - r.top + scrollEl.scrollTop) / pxPerMinute;
  }

  function viewportXToDate(vx) {
    const cols = S.cal.dayCols;
    if (!cols.length) return null;
    let best = cols[0], bestDist = Infinity;
    for (const col of cols) {
      const d = Math.abs(col.x - vx);
      if (d < bestDist) { bestDist = d; best = col; }
    }
    return best.date;
  }

  function getColBounds(date) {
    const col  = S.cal.dayCols.find(c => c.date === date);
    if (!col) return null;
    const cols = S.cal.dayCols;
    const idx  = cols.indexOf(col);
    const scrollR = S.cal.scrollEl ? S.cal.scrollEl.getBoundingClientRect() : null;

    // Left boundary: midpoint to previous column, or column left edge
    const left = idx === 0
      ? col.rect.left
      : (cols[idx - 1].x + col.x) / 2;

    // Right boundary: midpoint to next column, or scroll container content edge (excludes scrollbar)
    const right = idx === cols.length - 1
      ? (scrollR ? scrollR.left + S.cal.scrollEl.clientWidth : col.rect.right)
      : (col.x + cols[idx + 1].x) / 2;

    return { left, width: right - left };
  }

  function isInGrid(vx, vy) {
    const { scrollEl, dayCols } = S.cal;
    if (!scrollEl || !dayCols.length) return false;
    const r    = scrollEl.getBoundingClientRect();
    const left = Math.min(...dayCols.map(c => c.rect.left));
    return vx >= left && vx <= r.right && vy >= r.top && vy <= r.bottom;
  }

  function snap(minute) {
    const inc = S.settings.increment;
    return Math.round(minute / inc) * inc;
  }


  // ── Calibration ────────────────────────────────────────────────────────────

  function inferYear(dowName, monthDay) {
    const targetDow = DAY_NAMES.findIndex(d => d.toLowerCase() === dowName.toLowerCase());
    const thisYear  = new Date().getFullYear();
    for (const y of [thisYear, thisYear + 1, thisYear - 1]) {
      const d = new Date(`${monthDay}, ${y}`);
      if (!isNaN(d.getTime()) && d.getDay() === targetDow) {
        return `${y}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      }
    }
    return null;
  }

  function findDayCols() {
    const cols = [], seen = new Set();
    for (const el of document.querySelectorAll('[aria-label]')) {
      const m = COL_RE.exec(el.getAttribute('aria-label') || '');
      if (!m) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 1) continue;
      const date = inferYear(m[1], m[2]);
      if (!date || seen.has(date)) continue;
      seen.add(date);
      cols.push({ date, x: rect.left + rect.width / 2, rect });
    }
    return cols.sort((a, b) => a.x - b.x);
  }

  function findScrollEl(dayCols) {
    const gridLeft  = Math.min(...dayCols.map(c => c.rect.left));
    const gridRight = Math.max(...dayCols.map(c => c.rect.right));
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll('div')) {
      if (el.scrollHeight <= el.clientHeight + 10) continue;
      if (el.clientHeight < 200) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200) continue;
      if (r.right < gridLeft || r.left > gridRight) continue;
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    return best;
  }

  function isUnsupportedView() {
    return /\/r\/(month|year|agenda|schedule)/.test(location.pathname);
  }

  function calibrate() {
    if (isUnsupportedView()) { S.calibrated = false; return false; }
    const dayCols = findDayCols();
    if (!dayCols.length) return false;

    const scrollEl = findScrollEl(dayCols);
    if (!scrollEl || scrollEl.scrollHeight < 400) return false;

    // Register scroll listener directly on the container (scroll doesn't bubble)
    if (scrollEl !== S.cal.scrollEl) {
      scrollEl.addEventListener('scroll', onScroll, { passive: true });
    }

    S.cal.scrollEl    = scrollEl;
    S.cal.pxPerMinute = scrollEl.scrollHeight / (24 * 60);
    S.cal.dayCols     = dayCols;
    S.calibrated      = true;

    // Re-apply crosshair to the (possibly new) scroll element if mode is on
    applyCrosshair();
    return true;
  }

  function tryCalibrate(attempts) {
    if (calibrate()) {
      render();
      updateModeBtn();
      return;
    }
    if ((attempts || 0) < 20) {
      setTimeout(() => tryCalibrate((attempts || 0) + 1), 500);
    }
  }


  // ── Selections ─────────────────────────────────────────────────────────────

  function sortSelections() {
    S.selections.sort((a, b) =>
      a.date !== b.date ? a.date.localeCompare(b.date) : a.startMin - b.startMin
    );
  }

  function pushUndo() {
    S.undoStack.push(JSON.parse(JSON.stringify(S.selections)));
    if (S.undoStack.length > 10) S.undoStack.shift();
  }

  function addBlock(date, startMin, endMin) {
    if (startMin > endMin) [startMin, endMin] = [endMin, startMin];
    if (endMin - startMin < S.settings.increment) endMin = startMin + S.settings.increment;
    startMin = Math.max(0, startMin);
    endMin   = Math.min(1439, endMin);
    if (startMin >= endMin) return;

    const same  = S.selections.filter(s => s.date === date);
    const other = S.selections.filter(s => s.date !== date);
    const overlapping = same.filter(s => s.startMin <= endMin && s.endMin >= startMin);

    let ms = startMin, me = endMin;
    for (const b of overlapping) { ms = Math.min(ms, b.startMin); me = Math.max(me, b.endMin); }
    const unchanged = same.filter(s => !(s.startMin <= endMin && s.endMin >= startMin));

    S.selections = [...other, ...unchanged, { date, startMin: ms, endMin: me }];
    sortSelections();
  }

  function removeRange(block, removeStart, removeEnd) {
    pushUndo();
    removeStart = Math.max(removeStart, block.startMin);
    removeEnd   = Math.min(removeEnd,   block.endMin);
    if (removeStart >= removeEnd) return;

    S.selections = S.selections.filter(s =>
      !(s.date === block.date && s.startMin === block.startMin && s.endMin === block.endMin)
    );
    if (block.startMin < removeStart)
      S.selections.push({ date: block.date, startMin: block.startMin, endMin: removeStart });
    if (removeEnd < block.endMin)
      S.selections.push({ date: block.date, startMin: removeEnd, endMin: block.endMin });
    sortSelections();
  }

  function findBlockAt(date, minute) {
    return S.selections.find(s => s.date === date && minute >= s.startMin && minute < s.endMin) || null;
  }

  function undoLast() {
    if (!S.undoStack.length) return;
    S.selections = S.undoStack.pop();
    saveSel(); render(); updateOutput();
  }

  function clearAll() {
    pushUndo();
    S.selections = [];
    saveSel(); render(); updateOutput();
  }


  // ── Text generation ────────────────────────────────────────────────────────

  function fmtTime(minute) {
    const h24  = Math.floor(minute / 60) % 24;
    const mins = minute % 60;
    const h12  = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
    return `${h12}:${String(mins).padStart(2,'0')} ${h24 < 12 ? 'AM' : 'PM'}`;
  }

  function fmtDateTime(dateStr, minute, fmt) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt   = new Date(y, m - 1, d);
    const h24  = Math.floor(minute / 60);
    const mins = minute % 60;
    const h12  = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
    const ampm = h24 < 12 ? 'AM' : 'PM';
    return fmt.replace(TOKEN_RE, (t, literal) => {
      if (literal !== undefined) return literal; // [bracketed literal]
      switch (t) {
        case 'dddd': return DAY_NAMES[dt.getDay()];
        case 'ddd':  return DAY_NAMES[dt.getDay()].slice(0, 3);
        case 'MMMM': return MON_NAMES[m - 1];
        case 'MMM':  return MON_NAMES[m - 1].slice(0, 3);
        case 'MM':   return String(m).padStart(2, '0');
        case 'M':    return String(m);
        case 'DD':   return String(d).padStart(2, '0');
        case 'D':    return String(d);
        case 'YYYY': return String(y);
        case 'YY':   return String(y).slice(2);
        case 'hh':   return String(h12).padStart(2, '0');
        case 'h':    return String(h12);
        case 'HH':   return String(h24).padStart(2, '0');
        case 'H':    return String(h24);
        case 'mm':   return String(mins).padStart(2, '0');
        case 'A':    return ampm;
        case 'a':    return ampm.toLowerCase();
        default:     return t;
      }
    });
  }

  function tzAbbr() {
    const s = new Date().toLocaleTimeString('en-US', { timeZoneName: 'short' });
    return (s.match(/\b([A-Z]{2,5})\b$/) || ['',''])[1] || 'Local';
  }

  function generateText() {
    if (!S.selections.length) return '';
    const tz = tzAbbr();
    const prefix = S.settings.bullets ? '\u2022 ' : '';
    return S.selections
      .map(s => `${prefix}${fmtDateTime(s.date, s.startMin, S.settings.format)} \u2013 ${fmtTime(s.endMin)} ${tz}`)
      .join('\n');
  }


  // ── Renderer ───────────────────────────────────────────────────────────────

  let hlContainer = null;
  let previewEl   = null;

  function hexToRgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ].join(', ');
  }

  function setHighlightStyle(el, date, startMin, endMin, preview) {
    const bounds = getColBounds(date);
    if (!bounds) { el.style.display = 'none'; return; }
    const top    = minuteToViewportY(startMin);
    const bottom = minuteToViewportY(endMin);
    const rgb    = hexToRgb(S.settings.color);
    const op     = preview ? Math.min(S.settings.opacity + 0.15, 0.75) : S.settings.opacity;
    const bg     = preview && S.drag?.mode === 'remove'
      ? 'rgba(220, 53, 69, 0.55)'
      : `rgba(${rgb}, ${op})`;

    el.style.cssText = `
      position: fixed;
      display: block;
      top: ${top}px;
      height: ${Math.max(2, bottom - top)}px;
      left: ${bounds.left + 2}px;
      width: ${bounds.width - 4}px;
      background: ${bg};
      border-radius: 3px;
      pointer-events: none;
      z-index: ${preview ? 9002 : 9001};
      box-sizing: border-box;
      ${preview ? 'border: 2px dashed rgba(255,255,255,0.7);' : ''}
    `;
  }

  function render() {
    if (!hlContainer) return;
    hlContainer.innerHTML = '';
    if (!S.calibrated) return;
    const visibleDates = new Set(S.cal.dayCols.map(c => c.date));
    for (const sel of S.selections) {
      if (!visibleDates.has(sel.date)) continue;
      const div = document.createElement('div');
      setHighlightStyle(div, sel.date, sel.startMin, sel.endMin, false);
      div.dataset.date     = sel.date;
      div.dataset.startMin = sel.startMin;
      div.dataset.endMin   = sel.endMin;
      hlContainer.appendChild(div);
    }
  }

  function reposition() {
    if (!hlContainer || !S.calibrated) return;
    for (const div of hlContainer.querySelectorAll('[data-date]')) {
      setHighlightStyle(div, div.dataset.date,
        parseInt(div.dataset.startMin), parseInt(div.dataset.endMin), false);
    }
    if (S.drag) renderPreview();
  }

  function renderPreview() {
    if (!previewEl || !S.calibrated || !S.drag) {
      if (previewEl) previewEl.style.display = 'none';
      return;
    }
    const ds = S.drag;
    let startMin = Math.min(ds.startMin, ds.currentMin);
    let endMin   = Math.max(ds.startMin, ds.currentMin);

    if (ds.mode === 'remove' && ds.block) {
      startMin = Math.max(startMin, ds.block.startMin);
      endMin   = Math.min(endMin,   ds.block.endMin);
    } else {
      if (endMin - startMin < S.settings.increment) endMin = startMin + S.settings.increment;
    }
    startMin = Math.max(0, startMin);
    endMin   = Math.min(1439, endMin);
    if (endMin <= startMin) { previewEl.style.display = 'none'; return; }

    setHighlightStyle(previewEl, ds.date, startMin, endMin, true);
  }

  function updateColors() {
    if (!hlContainer) return;
    const rgb = hexToRgb(S.settings.color);
    const op  = S.settings.opacity;
    for (const div of hlContainer.querySelectorAll('[data-date]')) {
      div.style.background = `rgba(${rgb}, ${op})`;
    }
  }


  // ── Drag engine ────────────────────────────────────────────────────────────

  function initDrag() {
    document.addEventListener('mousedown', onMouseDown, { capture: true });
    document.addEventListener('mousemove', onMouseMove, { capture: true });
    document.addEventListener('mouseup',   onMouseUp,   { capture: true });
    document.addEventListener('click',     onDocClick,  { capture: true });
  }

  function isInsidePopup(target) {
    return !!target.closest('[role="menu"], [role="dialog"], [role="listbox"], [role="option"]');
  }

  function onDocClick(e) {
    if (!S.modeOn || !S.calibrated) return;
    if (e.target.closest('#cg-panel')) return;
    if (isInsidePopup(e.target)) return;
    if (!isInGrid(e.clientX, e.clientY)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onMouseDown(e) {
    if (!S.modeOn || !S.calibrated) return;
    if (e.target.closest('#cg-panel')) return;
    if (isInsidePopup(e.target)) return;
    if (!isInGrid(e.clientX, e.clientY)) return;

    e.preventDefault();
    e.stopPropagation();

    const date    = viewportXToDate(e.clientX);
    const minute  = snap(viewportYToMinute(e.clientY));
    if (!date) return;

    const hit = findBlockAt(date, minute);
    if (hit) {
      S.drag = { mode: 'remove', date, startMin: minute, currentMin: minute, block: hit };
    } else {
      pushUndo();
      S.drag = { mode: 'add', date, startMin: minute, currentMin: minute + S.settings.increment, block: null };
    }
    renderPreview();
  }

  function onMouseMove(e) {
    if (!S.drag) return;
    e.preventDefault();
    e.stopPropagation();
    const date   = viewportXToDate(e.clientX);
    const minute = snap(viewportYToMinute(e.clientY));
    S.drag.currentMin = minute;
    if (date) S.drag.date = date;
    renderPreview();
  }

  function onMouseUp(e) {
    if (!S.drag) return;
    e.preventDefault();
    e.stopPropagation();
    finalizeDrag();
  }

  function finalizeDrag() {
    const ds = S.drag;
    S.drag = null;
    if (previewEl) previewEl.style.display = 'none';
    if (!ds) return;

    if (ds.mode === 'add') {
      addBlock(ds.date, Math.min(ds.startMin, ds.currentMin), Math.max(ds.startMin, ds.currentMin));
    } else if (ds.mode === 'remove' && ds.block) {
      removeRange(ds.block, Math.min(ds.startMin, ds.currentMin), Math.max(ds.startMin, ds.currentMin));
    }
    saveSel(); render(); updateOutput();
  }


  // ── Scroll / resize ────────────────────────────────────────────────────────

  function onScroll() {
    if (S.scrollRaf) return;
    S.scrollRaf = true;
    requestAnimationFrame(() => {
      S.scrollRaf = false;
      reposition();
    });
  }


  // ── Panel ──────────────────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function injectPanel() {
    if (document.getElementById('cg-panel')) return;
    const panel = document.createElement('div');
    panel.id    = 'cg-panel';
    if (S.collapsed) panel.classList.add('cg-panel-collapsed');
    panel.innerHTML = `
      <div id="cg-tab" title="CalText">CT</div>
      <div id="cg-panel-body">
        <div id="cg-header">
          <span id="cg-title">CalText</span>
          <button id="cg-collapse-btn" title="Collapse">&#9664;</button>
        </div>
        <div id="cg-mode-row">
          <button id="cg-mode-toggle">Selection Mode: OFF</button>
        </div>
        <div id="cg-week-warning">⚠ Switch to <strong>week, day, or 4-day view</strong> to use CalText</div>
        <div id="cg-output-wrap">
          <textarea id="cg-output" readonly placeholder="Turn on Selection Mode, then click and drag on the calendar to add time blocks."></textarea>
        </div>
        <div id="cg-actions">
          <button class="cg-action-btn" id="cg-undo-btn">&#8629; Undo</button>
          <button class="cg-action-btn" id="cg-clear-btn">&#x2715; Clear</button>
          <button class="cg-action-btn" id="cg-copy-btn">&#x29C9; Copy</button>
        </div>
        <div id="cg-settings-wrap">
          <button id="cg-settings-toggle"><span class="cg-arrow">&#9658;</span> Settings</button>
          <div id="cg-settings-body">
            <div class="cg-setting-row">
              <label class="cg-setting-label">Date/time format <span style="font-weight:400;color:#80868b">(wrap literal text in [brackets])</span></label>
              <input class="cg-setting-input" id="cg-format-input" type="text" value="${escHtml(S.settings.format)}" placeholder="ddd, MMM D [at] h:mm A">
              <div id="cg-format-preview"></div>
            </div>
            <div class="cg-setting-row">
              <label class="cg-setting-label">Highlight color &amp; opacity</label>
              <div class="cg-color-row">
                <input id="cg-color-input" type="color" value="${escHtml(S.settings.color)}">
                <div class="cg-opacity-wrap">
                  <span>Opacity</span>
                  <input id="cg-opacity-input" type="range" min="5" max="75" value="${Math.round(S.settings.opacity * 100)}">
                  <span id="cg-opacity-val">${Math.round(S.settings.opacity * 100)}%</span>
                </div>
              </div>
            </div>
            <div class="cg-setting-row">
              <label class="cg-setting-label">Time snap increment</label>
              <div class="cg-increment-row">
                <button class="cg-increment-btn${S.settings.increment===15?' cg-active':''}" data-inc="15">15 min</button>
                <button class="cg-increment-btn${S.settings.increment===30?' cg-active':''}" data-inc="30">30 min</button>
              </div>
            </div>
            <div class="cg-setting-row">
              <label class="cg-setting-label">Output format</label>
              <div class="cg-increment-row">
                <button class="cg-increment-btn${S.settings.bullets?' cg-active':''}" data-bullets="true">&#x2022; Bullets</button>
                <button class="cg-increment-btn${!S.settings.bullets?' cg-active':''}" data-bullets="false">Plain</button>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(panel);
    bindPanelEvents();
    updateOutput();
    updateFormatPreview();
    updateModeBtn();
  }

  function bindPanelEvents() {
    const $  = id => document.getElementById(id);

    $('cg-tab').addEventListener('click', toggleCollapse);
    $('cg-collapse-btn').addEventListener('click', toggleCollapse);
    $('cg-mode-toggle').addEventListener('click', toggleMode);

    $('cg-undo-btn').addEventListener('click', undoLast);
    $('cg-clear-btn').addEventListener('click', clearAll);
    $('cg-copy-btn').addEventListener('click', () => {
      const text = $('cg-output').value;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const btn = $('cg-copy-btn');
        btn.classList.add('cg-copied');
        btn.textContent = '✓ Copied';
        setTimeout(() => { btn.classList.remove('cg-copied'); btn.innerHTML = '&#x29C9; Copy'; }, 1800);
      }).catch(() => { $('cg-output').select(); document.execCommand('copy'); });
    });

    $('cg-settings-toggle').addEventListener('click', () => {
      $('cg-settings-body').classList.toggle('cg-open');
      $('cg-settings-toggle').classList.toggle('cg-open');
    });

    $('cg-format-input').addEventListener('input', e => {
      S.settings.format = e.target.value;
      saveSet(); updateOutput(); updateFormatPreview();
    });

    $('cg-color-input').addEventListener('input', e => {
      S.settings.color = e.target.value;
      saveSet(); updateColors();
    });

    $('cg-opacity-input').addEventListener('input', e => {
      const v = parseInt(e.target.value);
      S.settings.opacity = v / 100;
      $('cg-opacity-val').textContent = `${v}%`;
      saveSet(); updateColors();
    });

    document.getElementById('cg-panel').addEventListener('click', e => {
      const btn = e.target.closest('.cg-increment-btn');
      if (!btn) return;

      if (btn.dataset.inc !== undefined) {
        const inc = parseInt(btn.dataset.inc);
        S.settings.increment = inc;
        saveSet();
        document.querySelectorAll('.cg-increment-btn[data-inc]').forEach(b =>
          b.classList.toggle('cg-active', parseInt(b.dataset.inc) === inc)
        );
      } else if (btn.dataset.bullets !== undefined) {
        const bullets = btn.dataset.bullets === 'true';
        S.settings.bullets = bullets;
        saveSet();
        document.querySelectorAll('.cg-increment-btn[data-bullets]').forEach(b =>
          b.classList.toggle('cg-active', b.dataset.bullets === String(bullets))
        );
        updateOutput();
      }
    });
  }

  function toggleCollapse() {
    S.collapsed = !S.collapsed;
    document.getElementById('cg-panel')?.classList.toggle('cg-panel-collapsed', S.collapsed);
  }

  function toggleMode() {
    S.modeOn = !S.modeOn;
    applyCrosshair();
    if (!S.modeOn && S.drag) { S.drag = null; if (previewEl) previewEl.style.display = 'none'; }
    updateModeBtn();
  }

  function applyCrosshair() {
    // Apply crosshair only to the calendar scroll container, not the whole page
    const scrollEl = S.cal.scrollEl;
    if (!scrollEl) return;
    if (S.modeOn) {
      scrollEl.style.setProperty('cursor', 'crosshair', 'important');
    } else {
      scrollEl.style.removeProperty('cursor');
    }
  }

  function updateModeBtn() {
    const btn     = document.getElementById('cg-mode-toggle');
    const warning = document.getElementById('cg-week-warning');
    if (!btn) return;
    const on = S.modeOn;
    btn.textContent = `Selection Mode: ${on ? 'ON' : 'OFF'}`;
    btn.classList.toggle('cg-mode-on', on);
    btn.disabled = !S.calibrated;
    btn.title    = '';
    if (warning) warning.style.display = S.calibrated ? 'none' : 'block';
  }

  function updateOutput() {
    const ta = document.getElementById('cg-output');
    if (ta) ta.value = generateText();
  }

  function updateFormatPreview() {
    const el = document.getElementById('cg-format-preview');
    if (!el) return;
    try {
      const now = new Date();
      const ds  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      const min = now.getHours() * 60 + Math.round(now.getMinutes() / 30) * 30;
      el.textContent = `e.g. "${fmtDateTime(ds, min, S.settings.format)}"`;
    } catch (_) { el.textContent = ''; }
  }


  // ── Overlay injection ──────────────────────────────────────────────────────

  function injectOverlay() {
    if (document.getElementById('cg-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id    = 'cg-overlay';
    hlContainer   = document.createElement('div');
    hlContainer.id = 'cg-highlight-container';
    overlay.appendChild(hlContainer);
    document.body.appendChild(overlay);

    previewEl     = document.createElement('div');
    previewEl.id  = 'cg-preview';
    previewEl.style.display = 'none';
    document.body.appendChild(previewEl);

    initDrag();
  }


  // ── Mutation observer & navigation ─────────────────────────────────────────

  let lastUrl  = location.href;
  let mutTimer = null;

  function onMutation() {
    clearTimeout(mutTimer);
    mutTimer = setTimeout(() => {
      if (!document.getElementById('cg-overlay')) injectOverlay();
      if (!document.getElementById('cg-panel'))   injectPanel();
      calibrate();
      render();
      updateModeBtn();
    }, 300);
  }

  function onNavigate() {
    const url = location.href;
    if (url === lastUrl) return;
    lastUrl = url;
    S.calibrated = false;
    if (S.modeOn) { S.modeOn = false; applyCrosshair(); }
    render();
    updateModeBtn();
    if (!isUnsupportedView()) setTimeout(() => tryCalibrate(), 500);
  }

  function patchHistory() {
    const orig = history.pushState.bind(history);
    history.pushState = (...a) => { orig(...a); onNavigate(); };
    const orig2 = history.replaceState.bind(history);
    history.replaceState = (...a) => { orig2(...a); onNavigate(); };
    window.addEventListener('popstate', onNavigate);
  }


  // ── Boot ───────────────────────────────────────────────────────────────────

  function init() {
    loadState();
    injectOverlay();
    injectPanel();

    // Start calibration loop
    tryCalibrate();

    // Recalibrate on resize
    window.addEventListener('resize', () => {
      clearTimeout(window._cgResizeTimer);
      window._cgResizeTimer = setTimeout(() => { if (calibrate()) { render(); } }, 250);
    });

    // MutationObserver for React re-renders
    new MutationObserver(onMutation).observe(document.body, { childList: true, subtree: true });

    // Watch for aria-label attribute changes on day column headers.
    // React updates these the instant the week changes — before pushState even fires.
    new MutationObserver(mutations => {
      for (const m of mutations) {
        const val = m.target.getAttribute('aria-label') || '';
        if (COL_RE.test(val)) {
          // A day header changed — week is transitioning, clear highlights immediately
          if (hlContainer) hlContainer.innerHTML = '';
          return;
        }
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['aria-label'], subtree: true });

    // SPA navigation
    patchHistory();

    // Clear selections on page unload (not on tab switch)
    window.addEventListener('beforeunload', () => {
      try { localStorage.removeItem(S_SEL); } catch (_) {}
    });
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

})();
