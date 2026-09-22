/* ============================================================
   BD List
   Reads the published Google Sheets CSV and renders:
     - one section per BD, with a card per status
     - a per-month stacked bar chart (Lost below the zero line)
     - a cursor-following tooltip carrying each row's Remarks
   No build step, no dependencies.
   ============================================================ */

(function () {
  'use strict';

  /* ==========================================================
     1. CONFIG - single source of truth
     ========================================================== */

  var CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQJrkTQFOO7VryCuwJRNX6wcBWvsDfG0r_goHm0QTNzIxY6q8RdNx4H_ttx0lBAzXcJS7elgOGuek1K/pub?gid=0&single=true&output=csv';

  // Pipeline order as numbered in the sheet, then the two terminal outcomes.
  var STATUS_ORDER = ['prospect', 'outreach', 'discovery', 'followup',
                      'proposal', 'deferred', 'rfp', 'won', 'lost'];

  var STATUS_LABEL = {
    prospect:  '1. Prospect Identified',
    outreach:  '2. Outreach Started',
    discovery: '3. Discovery Meeting',
    followup:  '4. Active follow-up',
    proposal:  '5. Proposal/Credentials Sent',
    deferred:  '6. Deferred/Cancelled',
    rfp:       '7. RFP/RFQ Provided',
    won:       'Won',
    lost:      'Lost',
    other:     'Other / Unrecognised'
  };

  // Statuses kept out of the chart entirely.
  var CHART_EXCLUDE = { deferred: true };
  // Statuses drawn below the zero line.
  var NEGATIVE_STATUSES = { lost: true };
  // Statuses whose cards start collapsed - the closed-out buckets, which are
  // bulky and rarely the thing you came to read.
  var COLLAPSED_BY_DEFAULT = { deferred: true, lost: true };

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var SHOW_UNSCHEDULED_BAR = false;              // blank Projected Month -> omitted from chart
  var CURRENCY_PREFIX      = '';                 // set to '₱' for peso
  var DEFAULT_YEAR         = new Date().getFullYear(); // only used once the sheet carries years
  var DEBUG_FORCE_LOST     = null;               // e.g. 'CODA' -> forces that client to Lost

  /* ==========================================================
     2. SMALL UTILITIES
     ========================================================== */

  var $ = function (id) { return document.getElementById(id); };

  var NF = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  function fmtAmount(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return CURRENCY_PREFIX + NF.format(n);
  }

  // 65660910 -> "65.7M"
  function fmtCompact(n) {
    var neg = n < 0;
    var v = Math.abs(n);
    var out;
    if (v >= 1e9)      out = trimZero(v / 1e9) + 'B';
    else if (v >= 1e6) out = trimZero(v / 1e6) + 'M';
    else if (v >= 1e3) out = trimZero(v / 1e3) + 'K';
    else               out = String(Math.round(v));
    return (neg ? '-' : '') + out;
  }

  function trimZero(x) {
    var s = x.toFixed(1);
    return s.slice(-2) === '.0' ? s.slice(0, -2) : s;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  var SVGNS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) { if (attrs[k] !== null) n.setAttribute(k, attrs[k]); }
    return n;
  }

  function svgText(x, y, cls, text, anchor) {
    var t = svgEl('text', { x: x, y: y, 'class': cls, 'text-anchor': anchor || 'middle' });
    t.textContent = text;
    return t;
  }

  /* ==========================================================
     3. CSV PARSER
     Hand-rolled: amounts are quoted and contain commas, so
     split(',') would shred them.
     ========================================================== */

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);  // strip BOM

    var rows = [], row = [], field = '', inQuotes = false, i = 0, c;

    while (i < text.length) {
      c = text[i];

      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }  // escaped quote
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }

      // A quote only opens a quoted field when nothing has been read yet,
      // so values like: 27" monitor  survive intact.
      if (c === '"' && field === '') { inQuotes = true; i++; continue; }

      if (c === ',')  { row.push(field); field = ''; i++; continue; }

      if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row);
        row = []; field = ''; i++;
        continue;
      }

      field += c; i++;
    }

    // Flush the tail only if it holds something - avoids a phantom row
    // from the trailing newline.
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

    return rows.filter(function (r) {
      return r.some(function (cell) { return String(cell).trim() !== ''; });
    });
  }

  /* ==========================================================
     4. FIELD NORMALISERS
     ========================================================== */

  function parseAmount(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw);
    s = s.replace(/ /g, ' ').trim();
    if (!s) return null;

    var negative = /^\(.*\)$/.test(s);                 // (1,234) accounting negative
    s = s.replace(/[^0-9.\-]/g, '');
    if (!s || s === '-' || s === '.') return null;

    var n = parseFloat(s);
    if (isNaN(n)) return null;
    return negative ? -Math.abs(n) : n;
  }

  var MONTH_LOOKUP = (function () {
    var full = ['january', 'february', 'march', 'april', 'may', 'june',
                'july', 'august', 'september', 'october', 'november', 'december'];
    var map = {};
    full.forEach(function (name, i) { map[name] = i; map[name.slice(0, 3)] = i; });
    map.sept = 8;
    return map;
  })();

  /**
   * Year-aware month parser.
   * Accepts: Sep | September | Sept | Sep 2026 | Sep-26 | Sep '26 | 2026-09 | 9/2026
   * Returns { month: 0-11, year: number|null } or null.
   */
  function parseMonth(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!s) return null;
    var m, mo;

    m = s.match(/^(\d{4})\s*[-/.]\s*(\d{1,2})$/);            // 2026-09
    if (m) { mo = +m[2] - 1; return (mo >= 0 && mo < 12) ? { month: mo, year: +m[1] } : null; }

    m = s.match(/^(\d{1,2})\s*[-/.]\s*(\d{4})$/);            // 9/2026
    if (m) { mo = +m[1] - 1; return (mo >= 0 && mo < 12) ? { month: mo, year: +m[2] } : null; }

    m = s.match(/^([A-Za-z]{3,9})\.?\s*[-/,']?\s*(\d{2,4})?$/); // Sep, Sep 2026, Sep-26
    if (m) {
      mo = MONTH_LOOKUP[m[1].toLowerCase()];
      if (mo === undefined) return null;
      var year = null;
      if (m[2]) year = m[2].length <= 2 ? 2000 + (+m[2]) : +m[2];
      return { month: mo, year: year };
    }

    return null;
  }

  // Matched AFTER the leading "1. " is stripped, so the sheet can carry the
  // numbers (it does today) or drop them later without any change here.
  var STATUS_ALIASES = {
    'prospect identified': 'prospect', 'prospect': 'prospect',
    'outreach started': 'outreach', 'outreach': 'outreach',
    'discovery meeting': 'discovery', 'discovery': 'discovery',
    'active follow-up': 'followup', 'active follow up': 'followup',
    'active followup': 'followup', 'follow-up': 'followup',
    'follow up': 'followup', 'followup': 'followup',
    'proposal/credentials sent': 'proposal', 'proposal/credentials': 'proposal',
    'proposal sent': 'proposal', 'credentials sent': 'proposal', 'proposal': 'proposal',
    'deferred/cancelled': 'deferred', 'deferred/canceled': 'deferred',
    'deferred': 'deferred', 'cancelled': 'deferred', 'canceled': 'deferred',
    'rfp/rfq provided': 'rfp', 'rfp/rfq': 'rfp', 'rfp provided': 'rfp',
    'rfq provided': 'rfp',
    'won': 'won',
    'lost': 'lost'
  };

  function canonStatus(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw)
      .toLowerCase().replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/').trim();
    if (!s) return 'other';
    s = s.replace(/^\d+\s*[.):\-]?\s*/, '');   // drop the "1. " / "2)" / "3 - " prefix
    var hit = STATUS_ALIASES[s];
    if (hit) return hit;
    console.warn('[BD] Unrecognised status: "' + raw + '" - filed under "Other".');
    return 'other';
  }

  /* ==========================================================
     5. BUILD THE ROW MODEL
     ========================================================== */

  function buildRows(csvText) {
    var table = parseCSV(csvText);
    if (!table.length) throw new Error('The CSV was empty.');

    // Map headers by NAME, so reordering columns in the sheet is harmless.
    var header = table[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var idx = {};
    header.forEach(function (h, i) { if (!(h in idx)) idx[h] = i; });

    ['status', 'amount', 'projected month'].forEach(function (need) {
      if (!(need in idx)) {
        throw new Error('Missing required column "' + need +
          '". Columns found: ' + header.join(', '));
      }
    });

    var get = function (cells, name) {
      var i = idx[name];
      if (i === undefined) return '';
      var v = cells[i];
      return v === undefined || v === null ? '' : String(v).trim();
    };

    var rows = table.slice(1).map(function (cells, i) {
      var client = get(cells, 'client');
      var status = canonStatus(get(cells, 'status'));

      if (DEBUG_FORCE_LOST && client.toLowerCase() === String(DEBUG_FORCE_LOST).toLowerCase()) {
        status = 'lost';
      }

      var bdRaw = get(cells, 'bd');
      var project = get(cells, 'project name');

      return {
        id: i,                                   // CSV row order - the join key (clients repeat)
        bdKey: bdRaw ? bdRaw.toLowerCase() : 'unassigned',
        bdLabel: bdRaw || 'Unassigned',
        client: client || '—',
        project: project,
        projectDisplay: project || '(No project name)',
        am: get(cells, 'am'),
        type: get(cells, 'type'),
        status: status,
        amount: parseAmount(get(cells, 'amount')),
        mo: parseMonth(get(cells, 'projected month')),
        remarks: get(cells, 'remarks')
      };
    });

    assignMonthKeys(rows);
    return rows;
  }

  /**
   * Decide month sort keys across the whole dataset.
   * With no years anywhere (today's sheet) we sort on the month index alone.
   * The moment ANY row carries a year the key upgrades to year*12+month,
   * so Jan 2027 sorts after Dec 2026 with no code change.
   */
  function assignMonthKeys(rows) {
    var hasAnyYear = rows.some(function (r) { return r.mo && r.mo.year !== null; });

    var years = {};
    if (hasAnyYear) {
      rows.forEach(function (r) {
        if (r.mo) years[r.mo.year === null ? DEFAULT_YEAR : r.mo.year] = true;
      });
    }
    var multiYear = Object.keys(years).length > 1;

    rows.forEach(function (r) {
      if (!r.mo) {
        r.monthKey = 'none';
        r.monthSort = Infinity;
        r.monthLabel = 'No Month';
        return;
      }
      if (hasAnyYear) {
        var y = r.mo.year === null ? DEFAULT_YEAR : r.mo.year;
        r.monthKey = y + '-' + r.mo.month;
        r.monthSort = y * 12 + r.mo.month;
        r.monthLabel = MONTHS[r.mo.month] + (multiYear ? ' ' + y : '');
      } else {
        r.monthKey = String(r.mo.month);
        r.monthSort = r.mo.month;
        r.monthLabel = MONTHS[r.mo.month];
      }
    });
  }

  /* ==========================================================
     6. GROUPING
     ========================================================== */

  function groupByBD(rows) {
    var map = {};

    rows.forEach(function (r) {
      var g = map[r.bdKey];
      if (!g) {
        g = map[r.bdKey] = { key: r.bdKey, label: r.bdLabel, count: 0, total: 0, byStatus: {} };
        // Pre-seed all seven statuses so empty cards render for free.
        STATUS_ORDER.forEach(function (s) { g.byStatus[s] = []; });
        g.byStatus.other = [];
      }
      g.byStatus[r.status].push(r);
      g.count++;
      if (r.amount !== null) g.total += r.amount;
    });

    var byAmountDesc = function (a, b) {
      if (a.amount === null && b.amount === null) return a.client.localeCompare(b.client);
      if (a.amount === null) return 1;             // null amounts sort last
      if (b.amount === null) return -1;
      if (b.amount !== a.amount) return b.amount - a.amount;
      return a.client.localeCompare(b.client);
    };

    var groups = Object.keys(map).map(function (k) { return map[k]; });
    groups.forEach(function (g) {
      Object.keys(g.byStatus).forEach(function (s) { g.byStatus[s].sort(byAmountDesc); });
    });

    groups.sort(function (a, b) {
      if (a.key === 'unassigned') return 1;        // Unassigned always last
      if (b.key === 'unassigned') return -1;
      return b.total - a.total;
    });

    return groups;
  }

  /* ==========================================================
     7. RENDER - BD SECTIONS
     ========================================================== */

  // 'default' opens everything except COLLAPSED_BY_DEFAULT; 'all' and 'none'
  // are the states the Expand/Collapse button puts us in. Every re-render (e.g.
  // after Refresh) honours the current mode, so the button never desyncs.
  var expandMode = 'default';

  function shouldOpen(statusKey, empty) {
    if (empty || expandMode === 'none') return false;
    if (expandMode === 'all') return true;
    return !COLLAPSED_BY_DEFAULT[statusKey];
  }

  function renderSections(groups) {
    var host = $('sections');
    host.textContent = '';

    groups.forEach(function (g) {
      var sec = el('section', 'bd');

      var head = el('div', 'bd__head');
      head.appendChild(el('h2', 'bd__name', g.label));
      head.appendChild(el('span', 'bd__meta',
        g.count + (g.count === 1 ? ' project' : ' projects') + ' · ' + fmtAmount(g.total)));
      sec.appendChild(head);

      var cards = el('div', 'bd__cards');
      var keys = STATUS_ORDER.slice();
      if (g.byStatus.other.length) keys.push('other');   // only when it has something

      keys.forEach(function (s) { cards.appendChild(buildCard(s, g.byStatus[s])); });
      sec.appendChild(cards);

      host.appendChild(sec);
    });
  }

  /* A cell whose text can outrun it: the outer span clips, the inner one
     is what actually slides on hover. */
  function scrollCell(cls, text) {
    var cell = el('span', cls);
    cell.appendChild(el('span', 'item__txt', text));
    return cell;
  }

  var SCROLL_SPEED = 70;   // px per second - roughly comfortable reading pace
  var SCROLL_TRAVEL_FRAC = 0.64;  // share of the cycle spent moving; the rest pauses

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // On hover, any cell whose text is clipped slides far enough to show the
  // rest, then eases back. Cells that already fit are left alone.
  function startCellScroll(item) {
    if (reduceMotion) return;
    var cells = item.querySelectorAll('.item__client, .item__project');
    Array.prototype.forEach.call(cells, function (cell) {
      var over = cell.scrollWidth - cell.clientWidth;
      if (over <= 1) return;
      var dur = Math.max(1.4, (over / SCROLL_SPEED) / SCROLL_TRAVEL_FRAC);
      cell.style.setProperty('--shift', (-over) + 'px');
      cell.style.setProperty('--dur', dur.toFixed(2) + 's');
      cell.classList.add('is-scrolling');
    });
  }

  // Clear document-wide rather than per-item, so a missed mouseout can never
  // strand a cell mid-slide.
  function stopCellScroll() {
    var cells = document.querySelectorAll('.is-scrolling');
    Array.prototype.forEach.call(cells, function (cell) {
      cell.classList.remove('is-scrolling');
      cell.style.removeProperty('--shift');
      cell.style.removeProperty('--dur');
    });
  }

  function buildCard(statusKey, items) {
    var empty = items.length === 0;

    var card = el('details', 'card card--' + statusKey + (empty ? ' card--empty' : ''));
    if (shouldOpen(statusKey, empty)) card.open = true;

    var head = el('summary', 'card__head');
    head.appendChild(el('span', 'card__dot'));
    head.appendChild(el('span', 'card__title', STATUS_LABEL[statusKey]));
    head.appendChild(el('span', 'card__count', String(items.length)));

    var sum = items.reduce(function (acc, r) { return acc + (r.amount === null ? 0 : r.amount); }, 0);
    head.appendChild(el('span', 'card__sum', empty ? '—' : fmtAmount(sum)));
    head.appendChild(el('span', 'card__chev'));
    card.appendChild(head);

    if (empty) {
      card.appendChild(el('p', 'card__empty', 'No projects'));
      // Keep it inert: nothing to reveal.
      head.addEventListener('click', function (e) { e.preventDefault(); });
      return card;
    }

    var list = el('ul', 'card__list');
    items.forEach(function (r) {
      var li = el('li', 'item' + (r.remarks ? ' item--note' : ''));
      li.setAttribute('data-rid', String(r.id));
      li.setAttribute('tabindex', '0');
      li.appendChild(scrollCell('item__client', r.client));
      li.appendChild(scrollCell('item__project', r.projectDisplay));
      li.appendChild(el('span',
        'item__amount' + (r.amount === null ? ' item__amount--none' : ''),
        fmtAmount(r.amount)));
      list.appendChild(li);
    });
    card.appendChild(list);

    return card;
  }

  /* ==========================================================
     8. RENDER - CHART
     ========================================================== */

  function niceStep(v) {
    if (!(v > 0)) return 1;
    var rough = v / 4;
    var mag = Math.pow(10, Math.floor(Math.log10(rough)));
    var mults = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < mults.length; i++) {
      if (mag * mults[i] >= rough) return mag * mults[i];
    }
    return mag * 10;
  }

  function buildMonthSlots(rows) {
    // The axis is built from EVERY month present in the column, BEFORE any
    // status filtering - so a month whose rows are all Deferred/Cancelled
    // (December, today) keeps its slot and renders as an empty bar.
    var slots = {}, order = [];

    rows.forEach(function (r) {
      if (r.monthKey === 'none' && !SHOW_UNSCHEDULED_BAR) return;
      if (!slots[r.monthKey]) {
        slots[r.monthKey] = {
          key: r.monthKey, label: r.monthLabel, sort: r.monthSort, pos: [], neg: []
        };
        order.push(slots[r.monthKey]);
      }
    });

    // Now drop the chartable rows into those slots.
    rows.forEach(function (r) {
      var slot = slots[r.monthKey];
      if (!slot) return;
      if (CHART_EXCLUDE[r.status]) return;
      if (r.amount === null || r.amount === 0) return;
      (NEGATIVE_STATUSES[r.status] ? slot.neg : slot.pos).push(r);
    });

    var byMagDesc = function (a, b) { return Math.abs(b.amount) - Math.abs(a.amount); };
    order.forEach(function (m) {
      m.pos.sort(byMagDesc);
      m.neg.sort(byMagDesc);
      m.posTotal = m.pos.reduce(function (s, r) { return s + Math.abs(r.amount); }, 0);
      m.negTotal = m.neg.reduce(function (s, r) { return s + Math.abs(r.amount); }, 0);
    });

    order.sort(function (a, b) { return a.sort - b.sort; });
    return order;
  }

  function renderChart(rows) {
    var svg = $('chart');
    svg.textContent = '';

    var months = buildMonthSlots(rows);
    var M = { top: 30, right: 22, bottom: 46, left: 86 };
    var VB_H = 460;
    var plotH = VB_H - M.top - M.bottom;

    if (!months.length) {
      svg.setAttribute('viewBox', '0 0 600 140');
      svg.setAttribute('width', 600);
      svg.setAttribute('height', 140);
      svg.appendChild(svgText(300, 75, 'emptymsg', 'No projects with a projected month.'));
      return;
    }

    // Size bands to the available width so 1 SVG unit == 1 CSS pixel (crisp text).
    var avail = Math.max(320, ($('chartblock').clientWidth || 900) - 42);
    var band = (avail - M.left - M.right) / months.length;
    band = Math.max(92, Math.min(190, band));
    var barW = Math.min(74, band * 0.56);

    var plotW = band * months.length;
    var VB_W = M.left + plotW + M.right;

    svg.setAttribute('viewBox', '0 0 ' + VB_W + ' ' + VB_H);
    svg.setAttribute('width', VB_W);
    svg.setAttribute('height', VB_H);

    // ---- scale: one shared unit so both halves are comparable -------------
    var maxPos = 0, maxNeg = 0;
    months.forEach(function (m) {
      if (m.posTotal > maxPos) maxPos = m.posTotal;
      if (m.negTotal > maxNeg) maxNeg = m.negTotal;
    });

    var step = niceStep(Math.max(maxPos, maxNeg));
    var axisPos = Math.ceil(maxPos / step) * step;
    var axisNeg = Math.ceil(maxNeg / step) * step;
    var span = (axisPos + axisNeg) || 1;                 // divide-by-zero guard
    var pxPerUnit = plotH / span;
    var zeroY = M.top + plotH * (axisPos / span);        // sits at the plot bottom when axisNeg === 0

    if (axisPos === 0 && axisNeg === 0) {
      svg.appendChild(svgText(VB_W / 2, VB_H / 2, 'emptymsg', 'No chartable amounts for these months.'));
      return;
    }

    // ---- gridlines + y labels ---------------------------------------------
    var grid = svgEl('g');
    var v;
    for (v = 0; v <= axisPos + 1e-6; v += step) {
      var gy = zeroY - v * pxPerUnit;
      grid.appendChild(svgEl('line', { x1: M.left, x2: M.left + plotW, y1: gy, y2: gy, 'class': 'grid' }));
      grid.appendChild(svgText(M.left - 10, gy + 4, 'ylabel', fmtCompact(v), 'end'));
    }
    for (v = step; v <= axisNeg + 1e-6; v += step) {
      var ny = zeroY + v * pxPerUnit;
      grid.appendChild(svgEl('line', { x1: M.left, x2: M.left + plotW, y1: ny, y2: ny, 'class': 'grid' }));
      grid.appendChild(svgText(M.left - 10, ny + 4, 'ylabel', fmtCompact(-v), 'end'));
    }
    svg.appendChild(grid);

    // ---- bars --------------------------------------------------------------
    var bars = svgEl('g', { 'shape-rendering': 'crispEdges' });

    months.forEach(function (m, i) {
      var x = M.left + i * band + (band - barW) / 2;

      // positive stack grows upward from the zero line.
      // The cursor accumulates PIXELS, not amounts - a sub-pixel segment is
      // skipped for drawing but still advances the cursor by its true height,
      // so the stack stays aligned with its total.
      var curPx = 0;
      m.pos.forEach(function (r) {
        var h = Math.abs(r.amount) * pxPerUnit;
        if (h >= 0.5) bars.appendChild(segRect(x, zeroY - (curPx + h), barW, h, r));
        curPx += h;
      });

      // negative stack (Lost) grows downward from the zero line
      curPx = 0;
      m.neg.forEach(function (r) {
        var h = Math.abs(r.amount) * pxPerUnit;
        if (h >= 0.5) bars.appendChild(segRect(x, zeroY + curPx, barW, h, r));
        curPx += h;
      });

      // totals
      var cx = x + barW / 2;
      if (m.posTotal > 0) {
        bars.appendChild(svgText(cx, zeroY - m.posTotal * pxPerUnit - 7, 'totlabel', fmtCompact(m.posTotal)));
      }
      if (m.negTotal > 0) {
        bars.appendChild(svgText(cx, zeroY + m.negTotal * pxPerUnit + 14, 'totlabel', fmtCompact(-m.negTotal)));
      }
      if (m.posTotal === 0 && m.negTotal === 0) {
        bars.appendChild(svgText(cx, zeroY - 7, 'totlabel totlabel--zero', '0'));
      }

      // x-axis label, always below the whole plot
      bars.appendChild(svgText(cx, M.top + plotH + 22, 'xlabel', m.label));
    });

    svg.appendChild(bars);

    // ---- zero line last, so it sits over the gridlines ---------------------
    svg.appendChild(svgEl('line', {
      x1: M.left, x2: M.left + plotW, y1: zeroY, y2: zeroY, 'class': 'zeroline'
    }));
  }

  function segRect(x, y, w, h, row) {
    // Inset a hairline only when the segment is tall enough to spare it.
    var inset = h > 3 ? 0.5 : 0;
    var r = svgEl('rect', {
      x: x, y: y + inset, width: w, height: Math.max(h - inset * 2, 0.5),
      'class': 'seg seg--' + row.status
    });
    r.setAttribute('data-rid', String(row.id));
    return r;
  }

  function renderLegend() {
    var host = $('legend');
    host.textContent = '';
    STATUS_ORDER.forEach(function (s) {
      var item = el('span', 'legend__item');
      var sw = el('span', 'legend__sw');
      sw.style.background = 'var(--c-' + s + ')';
      item.appendChild(sw);
      item.appendChild(el('span', null, STATUS_LABEL[s]));
      host.appendChild(item);
    });
  }

  /* ==========================================================
     9. CURSOR-FOLLOWING TOOLTIP
     ========================================================== */

  var rowsById = new Map();
  var tip, currentEl = null, visible = false, raf = 0;
  var pending = { x: 0, y: 0 };

  function tipForItem(row) {
    // List items show the Remarks and nothing else - and if there is no
    // remark, no balloon appears at all.
    if (!row.remarks) return null;
    return [el('div', 'tip__remark', row.remarks)];
  }

  function tipForSegment(row) {
    // A bare coloured rectangle is unidentifiable, so chart segments always
    // get an identifying balloon.
    var nodes = [];
    nodes.push(el('div', 'tip__title', row.client));
    nodes.push(el('div', 'tip__sub', row.projectDisplay));

    var rowEl = el('div', 'tip__row');
    rowEl.appendChild(el('span', 'tip__chip chip--' + row.status, STATUS_LABEL[row.status]));
    var neg = NEGATIVE_STATUSES[row.status];
    rowEl.appendChild(el('span', 'tip__amt' + (neg ? ' tip__neg' : ''),
      (neg ? '-' : '') + fmtAmount(Math.abs(row.amount))));
    nodes.push(rowEl);

    if (row.remarks) {
      var rm = el('div', 'tip__remark', row.remarks);
      rm.style.marginTop = '5px';
      nodes.push(rm);
    }
    return nodes;
  }

  function showTip() { visible = true; tip.classList.add('is-on'); tip.setAttribute('aria-hidden', 'false'); }

  function hideTip() {
    visible = false;
    tip.classList.remove('is-on');
    tip.setAttribute('aria-hidden', 'true');
  }

  function scheduleMove() {
    if (raf || !visible) return;
    raf = requestAnimationFrame(placeTip);
  }

  function placeTip() {
    raf = 0;
    if (!visible) return;
    var OFF = 14, PAD = 8;
    var r = tip.getBoundingClientRect();          // measured after content is set
    var x = pending.x + OFF;
    var y = pending.y + OFF;
    if (x + r.width  + PAD > window.innerWidth)  x = pending.x - r.width  - OFF;  // flip left
    if (y + r.height + PAD > window.innerHeight) y = pending.y - r.height - OFF;  // flip up
    tip.style.transform = 'translate(' + Math.max(PAD, x) + 'px,' + Math.max(PAD, y) + 'px)';
  }

  function fillTip(target) {
    var row = rowsById.get(+target.getAttribute('data-rid'));
    if (!row) return false;
    var nodes = target.classList && target.classList.contains('seg')
      ? tipForSegment(row)
      : tipForItem(row);
    if (!nodes) return false;                     // blank remarks -> no balloon
    tip.textContent = '';
    nodes.forEach(function (n) { tip.appendChild(n); });
    return true;
  }

  function initTooltip() {
    tip = $('tooltip');
    var root = $('hoverRoot');

    if (!window.matchMedia || window.matchMedia('(hover: hover)').matches) {
      root.addEventListener('mouseover', function (e) {
        var t = e.target.closest ? e.target.closest('[data-rid]') : null;
        if (!t || t === currentEl) return;
        currentEl = t;
        stopCellScroll();
        if (t.classList.contains('item')) startCellScroll(t);
        pending.x = e.clientX; pending.y = e.clientY;
        if (fillTip(t)) { showTip(); placeTip(); } else { hideTip(); }
      });

      root.addEventListener('mousemove', function (e) {
        if (!visible) return;
        pending.x = e.clientX; pending.y = e.clientY;
        scheduleMove();
      });

      // mouseover/mouseout (not enter/leave) because only these bubble.
      root.addEventListener('mouseout', function (e) {
        var to = e.relatedTarget;
        if (to && to.closest && to.closest('[data-rid]') === currentEl) return;
        currentEl = null;
        stopCellScroll();
        hideTip();
      });
    }

    // Keyboard users: anchor to the element instead of the cursor.
    root.addEventListener('focusin', function (e) {
      var t = e.target.closest ? e.target.closest('[data-rid]') : null;
      if (!t) return;
      currentEl = t;
      stopCellScroll();
      if (t.classList.contains('item')) startCellScroll(t);
      if (!fillTip(t)) { hideTip(); return; }
      var r = t.getBoundingClientRect();
      pending.x = r.left + 8; pending.y = r.bottom - 4;
      showTip(); placeTip();
    });
    root.addEventListener('focusout', function () {
      currentEl = null; stopCellScroll(); hideTip();
    });

    // Capture phase so inner scrollers are caught too.
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('wheel', hideTip, { passive: true });
  }

  /* ==========================================================
     10. LOAD / REFRESH / INIT
     ========================================================== */

  var lastRows = null;
  var resizeTimer = 0;

  function setBanner(msg) {
    var b = $('banner');
    if (!msg) { b.hidden = true; b.textContent = ''; return; }
    b.textContent = msg;
    b.hidden = false;
  }

  function showFatal(titleText, bodyNodes) {
    var f = $('fatal');
    f.textContent = '';
    f.appendChild(el('h2', null, titleText));
    bodyNodes.forEach(function (n) { f.appendChild(n); });
    f.hidden = false;
    $('loading').hidden = true;
  }

  function fileProtocolPanel() {
    var p1 = el('p', null,
      'Google blocks the data request when this page is opened straight from disk ' +
      '(the redirect it uses carries no CORS header for file:// pages), so the dashboard ' +
      'has to be served over http.');
    var p2 = el('p', null, 'Run serve.cmd in this folder, or from a terminal here:');
    var p3 = el('p', null);
    p3.appendChild(el('code', null, 'python -m http.server 8000'));
    var p4 = el('p', null);
    p4.appendChild(document.createTextNode('Then open '));
    p4.appendChild(el('code', null, 'http://localhost:8000'));
    return [p1, p2, p3, p4];
  }

  function render(rows, sourceNote) {
    lastRows = rows;

    rowsById = new Map();
    rows.forEach(function (r) { rowsById.set(r.id, r); });

    renderSections(groupByBD(rows));
    renderLegend();
    renderChart(rows);

    $('stamp').textContent = sourceNote;
    $('loading').hidden = true;
    $('chartblock').hidden = false;
  }

  function useSnapshot(reason) {
    var csv = window.BD_SNAPSHOT_CSV;
    if (!csv) {
      showFatal('Could not load the pipeline data', [
        el('p', null, reason),
        el('p', null, 'No bundled snapshot is available either.')
      ]);
      return;
    }
    var stampedOn = window.BD_SNAPSHOT_DATE || 'an earlier date';
    render(buildRows(csv), 'Snapshot · ' + stampedOn);
    setBanner('Live fetch failed (' + reason + '). Showing the bundled snapshot from ' +
      stampedOn + ' — press Refresh to try again.');
  }

  function loadLive(isRefresh) {
    var btn = $('refresh');
    btn.disabled = true;
    btn.classList.add('is-busy');
    $('refreshLabel').textContent = isRefresh ? 'Refreshing…' : 'Loading…';

    return fetch(CSV_URL, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        var rows = buildRows(text);
        var now = new Date();
        render(rows, 'Updated ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        setBanner(null);
        $('fatal').hidden = true;
      })
      .catch(function (err) {
        var reason = err && err.message ? err.message : 'network error';
        console.error('[BD] live fetch failed:', err);
        if (lastRows) {
          // Keep the good render on screen, just report the failure.
          setBanner('Refresh failed (' + reason + '). Still showing the previous data.');
        } else {
          useSnapshot(reason);
        }
      })
      .then(function () {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        $('refreshLabel').textContent = 'Refresh';
      });
  }

  function syncToggle() {
    var t = $('toggleAll');
    var open = expandMode !== 'none';
    t.setAttribute('aria-pressed', open ? 'true' : 'false');
    t.textContent = open ? 'Collapse all' : 'Expand all';
  }

  function initControls() {
    $('refresh').addEventListener('click', function () { loadLive(true); });

    var toggle = $('toggleAll');
    toggle.addEventListener('click', function () {
      // Always offer the opposite bulk action. Expanding from 'none' goes to
      // 'all', which deliberately opens the default-collapsed cards too.
      expandMode = (expandMode === 'none') ? 'all' : 'none';
      var open = expandMode === 'all';
      var cards = document.querySelectorAll('.card:not(.card--empty)');
      Array.prototype.forEach.call(cards, function (c) { c.open = open; });
      syncToggle();
    });
    syncToggle();

    // Re-lay the chart to the new width; bands are sized in real pixels.
    window.addEventListener('resize', function () {
      if (!lastRows) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { renderChart(lastRows); }, 150);
    });
  }

  function init() {
    initTooltip();
    initControls();

    if (location.protocol === 'file:') {
      // Render the snapshot so the page is still useful, and explain the fix.
      showFatal('Open this page over http, not from the file system', fileProtocolPanel());
      if (window.BD_SNAPSHOT_CSV) {
        render(buildRows(window.BD_SNAPSHOT_CSV),
          'Snapshot · ' + (window.BD_SNAPSHOT_DATE || ''));
      }
      $('refresh').disabled = true;
      return;
    }

    loadLive(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
