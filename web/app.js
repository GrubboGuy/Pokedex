/* Pokédex weekly: renders the issue files written by the data job. No build step. */
(function () {
  'use strict';

  var screen = document.getElementById('screen');
  var tabsEl = document.getElementById('tabs');
  var issueNoEl = document.getElementById('issue-no');
  var cache = {};
  var indexPromise = null, searchPromise = null, setCache = {};
  var swipe = { prev: null, next: null };
  var slideFrom = null;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var TIERS = { UNOPENED: 'Sealed', NEAR_MINT: 'Near Mint', LIGHTLY_PLAYED: 'Lightly Played', MODERATELY_PLAYED: 'Moderately Played', HEAVILY_PLAYED: 'Heavily Played', DAMAGED: 'Damaged' };
  // Color families: each list has one, and each era maps onto the family of its era list.
  var TONE = { 'big-movers': 'movers', 'get-em-now': 'rebound', 'hot-vintage': 'vintage', 'hot-middle': 'mid', 'hot-sm-swsh': 'sunsword', 'hot-modern': 'modern', 'modern-sealed': 'sealed', 'hidden-gems': 'gems', 'on-sale': 'sale', 'holding': 'steady' };
  var ERAS = {
    wotc: ['Wizards era', 'vintage'], ex: ['EX era', 'vintage'],
    dp: ['Diamond & Pearl era', 'mid'], bwxy: ['BW and XY era', 'mid'],
    sm: ['Sun & Moon era', 'sunsword'], swsh: ['Sword & Shield era', 'sunsword'],
    sv: ['Scarlet & Violet era', 'modern'], mega: ['Mega Evolution era', 'modern']
  };
  var ERA_STARTS = [['wotc', '1999-01-01'], ['ex', '2003-07-01'], ['dp', '2007-05-01'], ['bwxy', '2011-04-01'], ['sm', '2017-02-01'], ['swsh', '2020-02-01'], ['sv', '2023-03-01'], ['mega', '2025-09-01']];

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n, trim) {
    if (n == null) return '';
    var whole = trim && n >= 1000;
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  }
  function pct(x) {
    if (x == null) return 'n/a';
    var v = Math.round(x * 100);
    return (v > 0 ? '+' : '') + v + '%';
  }
  function dir(x) { return x == null || Math.round(x * 100) === 0 ? 'flat' : (x > 0 ? 'up' : 'down'); }
  function tri(x) { var d = dir(x); return d === 'flat' ? '' : '<i class="tri ' + d + '"></i>'; }
  function move(x) { return '<span class="move ' + dir(x) + '">' + tri(x) + pct(x) + '</span>'; }
  // A pick's headline figure: its short-term move, or for picks without a trend, the listing gap.
  function headlineMove(p) {
    if (p.ch7 != null) return move(p.ch7);
    var gap = Math.round((1 - p.low / p.price) * 100);
    return '<span class="move gap">' + gap + '% under market</span>';
  }
  function niceDate(iso, withYear) {
    var p = iso.split('-');
    return MONTHS[+p[1] - 1] + ' ' + (+p[2]) + (withYear === false ? '' : ', ' + p[0]);
  }
  function span(issue) { return issue.shortSpanDays || 7; }
  function pad(n, len) { n = String(n); while (n.length < len) n = '0' + n; return n; }
  function bigImage(url) { return url ? url.replace('_200w.', '_in_1000x1000.') : ''; }
  function productImage(id) { return 'https://tcgplayer-cdn.tcgplayer.com/product/' + id + '_200w.jpg'; }
  // "Terapagos ex - 173/142" -> "Terapagos ex" for headlines; the number is shown beside the set.
  function shortName(name) { return String(name || '').replace(/\s+-\s+[A-Za-z0-9]+\/[A-Za-z0-9]+$/, ''); }
  function tierName(t) { return TIERS[t] || String(t).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function tone(cat) { return 't-' + (TONE[cat.id] || 'steady'); }
  function eraChip(era) { var e = ERAS[era]; return e ? '<span class="era t-' + e[1] + '">' + e[0] + '</span>' : ''; }
  function eraTone(era) { return ERAS[era] ? 't-' + ERAS[era][1] : ''; }
  var ERA_PREFIXES = [['ME', 'mega'], ['SV', 'sv'], ['SWSH', 'swsh'], ['SM', 'sm'], ['XY', 'bwxy'], ['BW', 'bwxy'], ['HGSS', 'dp'], ['DP', 'dp']];
  // Same rule as the data job: the set name's prefix when it has one, else the release date.
  function eraOf(setName, d) {
    var era = null, m = /^([A-Z]+)(\d|:|\s|-)/.exec(setName || '');
    if (m) ERA_PREFIXES.forEach(function (p) { if (!era && p[0] === m[1]) era = p[1]; });
    if (!era && d) ERA_STARTS.forEach(function (s) { if (d >= s[1]) era = s[0]; });
    return era;
  }

  var PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350"><rect width="250" height="350" rx="12" fill="#F5F6F8"/>' +
    '<rect x="16" y="16" width="218" height="318" rx="8" fill="none" stroke="#D5D8DF" stroke-width="3"/>' +
    '<path d="M95 190l22-26 18 18 24-32" fill="none" stroke="#B9BEC9" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>');

  function img(pick, cls, big) {
    var small = pick.image || PLACEHOLDER;
    var src = big && pick.image ? bigImage(pick.image) : small;
    var kind = pick.kind === 'sealed' ? ' sealed' : '';
    return '<img class="' + (cls || 'card-img') + kind + '" src="' + esc(src) + '" data-small="' + esc(small) +
      '" alt="' + esc(pick.name) + '" loading="' + (big ? 'eager' : 'lazy') + '" decoding="async">';
  }
  // Fall back from the large image to the small one, then to a drawn placeholder.
  document.addEventListener('error', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'IMG') return;
    var small = el.getAttribute('data-small');
    if (small && el.src !== small && !el.dataset.triedSmall) { el.dataset.triedSmall = '1'; el.src = small; return; }
    if (el.src !== PLACEHOLDER) { el.src = PLACEHOLDER; el.classList.add('missing'); }
  }, true);

  function score(pick) {
    return '<span class="score" title="' + esc(pick.scoreLabel) + ' score, 1 to 99"><b>' + pick.score + '</b><small>' + esc(pick.scoreLabel) + '</small></span>';
  }
  function verdict(p) {
    if (p.scoreLabel === 'Deal') return p.score >= 80 ? 'Deep discount' : (p.score >= 70 ? 'Solid discount' : 'Mild discount');
    if (p.scoreLabel === 'Swing') return p.ch7 > 0 ? 'Big jump' : 'Sharp drop';
    if (p.scoreLabel === 'Rebound') return p.score >= 72 ? 'Strong setup' : (p.score >= 64 ? 'Good setup' : 'Early sign');
    if (p.scoreLabel === 'Steady') return p.score >= 85 ? 'Rock steady' : 'Steady';
    return p.score >= 80 ? 'Red hot' : (p.score >= 65 ? 'Hot' : 'Warming up');
  }
  function listTitle(cat) { return (cat.id.indexOf('hot-') === 0 ? '🔥 ' : '') + cat.title; }
  function where(p) {
    var bits = [p.set];
    if (p.number) bits.push('#' + p.number);
    if (p.printing && p.printing !== 'Normal') bits.push(p.printing);
    return bits.filter(Boolean).join(', ');
  }

  // ---------- data ----------
  function getJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' returned ' + r.status);
      return r.json();
    });
  }
  function getIndex() {
    if (!indexPromise) indexPromise = getJSON('data/index.json');
    return indexPromise;
  }
  function getIssue(number) {
    return getIndex().then(function (index) {
      if (!index.length) throw new Error('empty');
      var n = number || index[0].number;
      if (!cache[n]) cache[n] = getJSON('data/issue-' + n + '.json');
      return cache[n].then(function (issue) { return { issue: issue, latest: index[0].number, index: index }; });
    });
  }
  function getSearch() {
    if (!searchPromise) {
      searchPromise = getJSON('data/search.json').then(function (data) {
        var rar = {}, prt = {};
        data.setEra = data.sets.map(function (s) { return eraOf(s[1], s[3]); });
        data.setCount = data.sets.map(function () { return 0; });
        data.hay = data.items.map(function (it) {
          var s = data.sets[it[2]];
          data.setCount[it[2]]++;
          if (it[5] && it[5] !== 'None' && it[5] !== 'Unconfirmed') rar[it[5]] = (rar[it[5]] || 0) + 1;
          it[6].forEach(function (p) { prt[p[0]] = (prt[p[0]] || 0) + 1; });
          return plain(it[1] + ' ' + s[1] + ' ' + (s[2] || '') + ' ' + (it[3] || ''));
        });
        var byCount = function (o) { return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }); };
        data.rarities = byCount(rar);
        data.printings = byCount(prt);
        return data;
      });
      searchPromise.catch(function () { searchPromise = null; });
    }
    return searchPromise;
  }
  function getSet(gid) {
    if (!setCache[gid]) setCache[gid] = getJSON('data/sets/' + gid + '.json').catch(function () { delete setCache[gid]; return null; });
    return setCache[gid];
  }
  function base(ctx) { return ctx.issue.number === ctx.latest ? '#' : '#/issue/' + ctx.issue.number; }

  // ---------- chrome ----------
  function renderTabs(ctx, activeId) {
    var b = base(ctx);
    var tabs = [['', 'Front page', 'front']].concat(ctx.issue.categories.map(function (c) { return [c.id, c.short || c.title, TONE[c.id] || 'steady']; }));
    tabsEl.innerHTML = tabs.map(function (t) {
      return '<a class="t-' + t[2] + '" href="' + b + (t[0] ? '/list/' + t[0] : '/') + '"' + (t[0] === activeId ? ' aria-current="true"' : '') + '><i class="dot"></i>' + esc(t[1]) + '</a>';
    }).join('');
    tabsEl.hidden = false;
    var on = tabsEl.querySelector('[aria-current]');
    if (on) tabsEl.scrollTo({ left: Math.max(0, on.offsetLeft - (tabsEl.clientWidth - on.offsetWidth) / 2), behavior: reduceMotion ? 'auto' : 'smooth' });
  }
  function sectionPager(ctx, activeId) {
    var b = base(ctx), cats = ctx.issue.categories;
    var order = [{ id: '', name: 'Front page' }].concat(cats.map(function (c) { return { id: c.id, name: c.short || c.title }; }));
    var i = order.map(function (o) { return o.id; }).indexOf(activeId);
    var prev = order[i - 1], next = order[i + 1];
    var href = function (o) { return b + (o.id ? '/list/' + o.id : '/'); };
    swipe.prev = prev ? href(prev) : null;
    swipe.next = next ? href(next) : null;
    return '<nav class="pager" aria-label="Sections">' +
      (prev ? '<a class="prev" href="' + href(prev) + '"><small>Previous section</small><b>' + esc(prev.name) + '</b></a>' : '<span></span>') +
      (next ? '<a class="next" href="' + href(next) + '"><small>Next section</small><b>' + esc(next.name) + '</b></a>' : '<span></span>') +
      '</nav><p class="swipe-hint">Swipe left or right to move between sections.</p>';
  }

  // ---------- views ----------
  function frontView(ctx) {
    var issue = ctx.issue, b = base(ctx), days = span(issue);
    var coverCat = null, coverPick = null, total = 0;
    issue.categories.forEach(function (c) {
      total += c.picks.length;
      c.picks.forEach(function (p) {
        if (issue.cover && c.id === issue.cover.category && p.key === issue.cover.key) { coverCat = c; coverPick = p; }
      });
    });
    if (!coverPick) { coverCat = issue.categories[0]; coverPick = coverCat.picks[0]; }
    var coverHref = b + '/card/' + coverCat.id + '/' + coverPick.rank;

    var sections = issue.categories.map(function (c) {
      var p = c.picks[0];
      var art = c.picks.slice(0, 3).map(function (x) { return img(x, 'thumb'); }).join('');
      return '<li class="' + tone(c) + '"><a href="' + b + '/list/' + c.id + '">' +
        '<span><h3>' + esc(listTitle(c)) + '</h3><p class="blurb">' + esc(c.blurb) + '</p>' +
        '<p class="lead-line"><b>' + esc(shortName(p.name)) + '</b><span class="price">' + money(p.price) + '</span>' + headlineMove(p) + '</p></span>' +
        '<span class="sec-art">' + art + '</span></a></li>';
    }).join('');

    var s = issue.stats;
    return '<header class="front-head"><div class="dateline eyebrow"><span>Issue ' + pad(issue.number, 2) + '</span><span>Week of ' + niceDate(issue.date) + '</span></div>' +
      '<h1>This week&#39;s picks</h1>' +
      '<p class="deck">' + total + ' cards and sealed products worth a look, chosen by rule from ' + Number(s.productsScanned).toLocaleString('en-US') + ' tracked products.</p>' +
      '<button type="button" class="cta" id="strategy">This week&#39;s strategy<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></header>' +
      '<a class="hero ' + tone(coverCat) + '" href="' + coverHref + '">' + img(coverPick, 'card-img', true) +
        '<span><span class="eyebrow"><i class="dot"></i>Top pick, ' + esc(coverCat.short || coverCat.title) + '</span>' +
        '<h2>' + esc(shortName(coverPick.name)) + '</h2><p class="where">' + esc(where(coverPick)) + '</p>' +
        '<span class="figures"><span class="price">' + money(coverPick.price) + '</span>' + headlineMove(coverPick) + '</span>' + score(coverPick) + '</span>' +
        '<span class="hero-why deck">' + esc(coverPick.reason) + '</span></a>' +
      '<h2 class="strip">Sections <span>' + issue.categories.length + ' lists, ' + total + ' picks</span></h2>' +
      '<ol class="sections">' + sections + '</ol>' +
      '<div class="block dark stats"><div><b>' + Number(s.productsScanned).toLocaleString('en-US') + '</b><span>products checked</span></div>' +
        '<div><b>' + s.snapshots + '</b><span>days of prices since ' + niceDate(s.historyFrom, false) + '</span></div>' +
        '<div><b>' + days + ' days</b><span>short-term move in this issue</span></div></div>' +
      '<p class="note fine">Prices are TCGplayer market prices via TCGCSV, pulled ' + niceDate(issue.date) + '. Market information, not financial advice; past moves do not predict future prices. ' +
        '<a href="#/how">How the picks are made</a>. Not affiliated with or endorsed by Nintendo, The Pokémon Company, TCGplayer or eBay.</p>' +
      sectionPager(ctx, '');
  }

  function listView(ctx, id) {
    var issue = ctx.issue, b = base(ctx), days = span(issue);
    var idx = issue.categories.map(function (c) { return c.id; }).indexOf(id);
    var cat = issue.categories[idx];
    if (!cat) return notFound();
    var lead = cat.picks[0];
    var rest = cat.picks.slice(1).map(function (p) {
      return '<a class="pick" href="' + b + '/card/' + cat.id + '/' + p.rank + '">' +
        '<div class="pick-art"><span class="rank">' + p.rank + '</span>' + img(p) + '</div>' +
        '<div class="pick-info"><h3>' + esc(shortName(p.name)) + '</h3><p class="where">' + esc(where(p)) + '</p>' +
        (p.era ? '<div class="tags">' + eraChip(p.era) + '</div>' : '') +
        '<div class="figures"><span class="price">' + money(p.price) + '</span>' + headlineMove(p) + '</div>' + score(p) + '</div></a>';
    }).join('');
    var trendNote = lead.ch7 != null ? 'Change shown is the ' + days + '-day move in TCGplayer market price, as of ' + niceDate(issue.date) + '.'
      : 'Prices are TCGplayer market prices and lowest listings as of ' + niceDate(issue.date) + '.';
    return '<div class="' + tone(cat) + '"><header class="sec-head band"><span class="eyebrow"><i class="dot"></i>Section ' + (idx + 1) + ' of ' + issue.categories.length + '</span>' +
      '<h1>' + esc(listTitle(cat)) + '</h1><p class="deck">' + esc(cat.blurb) + '</p></header>' +
      '<a class="lead" href="' + b + '/card/' + cat.id + '/' + lead.rank + '">' +
        '<div class="lead-art"><span class="rank">1</span>' + img(lead, 'card-img', true) + '</div>' +
        '<div><h2>' + esc(shortName(lead.name)) + '</h2><p class="where">' + esc(where(lead)) + '</p>' +
        (lead.era ? '<div class="tags">' + eraChip(lead.era) + '</div>' : '') +
        '<div class="figures"><span class="price">' + money(lead.price) + '</span>' + headlineMove(lead) + '</div>' + score(lead) + '</div>' +
        '<p class="lead-why deck">' + esc(lead.reason) + '</p></a>' +
      '<div class="picks">' + rest + '</div>' +
      '<div class="block tint aside"><b>How this list is picked</b><p>' + esc(cat.rule) + ' ' + cat.eligible + ' passed this week; these are the top ' + cat.picks.length + '.</p></div>' +
      '<p class="note fine">' + trendNote + '</p>' + sectionPager(ctx, cat.id) + '</div>';
  }

  function chart(series) {
    if (series.length < 2) return '<p class="note">Price history for this item starts ' + niceDate(series[0][0]) + '. A chart appears once more days are on file.</p>';
    var W = 340, H = 170, L = 4, R = 50, T = 14, B = 24;
    var vals = series.map(function (s) { return s[1]; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) { hi = lo * 1.05 + 0.01; lo = lo * 0.95; }
    var padY = (hi - lo) * 0.12; lo = Math.max(0, lo - padY); hi = hi + padY;
    var t0 = Date.parse(series[0][0]), t1 = Date.parse(series[series.length - 1][0]);
    var X = function (d) { return L + (t1 === t0 ? 0.5 : (Date.parse(d) - t0) / (t1 - t0)) * (W - L - R); };
    var Y = function (v) { return T + (1 - (v - lo) / (hi - lo)) * (H - T - B); };
    var pts = series.map(function (s) { return X(s[0]).toFixed(1) + ',' + Y(s[1]).toFixed(1); });
    var grid = [0, 0.5, 1].map(function (f) {
      var v = lo + (hi - lo) * f, y = Y(v).toFixed(1);
      return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="#E3E5EA" stroke-width="1"/>' +
        '<text x="' + (W - R + 7) + '" y="' + (+y + 4) + '" font-size="11" fill="#5B6070">' + money(v, true).replace(/\.\d\d$/, v >= 100 ? '' : '$&') + '</text>';
    }).join('');
    var last = series[series.length - 1];
    return '<div class="chart" data-series="' + esc(JSON.stringify(series)) + '">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Price from ' + niceDate(series[0][0]) + ' to ' + niceDate(last[0]) + '">' + grid +
      '<polygon points="' + L + ',' + (H - B) + ' ' + pts.join(' ') + ' ' + X(last[0]).toFixed(1) + ',' + (H - B) + '" fill="currentColor" opacity=".09"/>' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + X(last[0]).toFixed(1) + '" cy="' + Y(last[1]).toFixed(1) + '" r="4" fill="currentColor" stroke="#fff" stroke-width="2"/>' +
      '<line class="cross" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" stroke="#0F1115" stroke-width="1" visibility="hidden"/>' +
      '<circle class="dot-h" r="4.5" fill="#fff" stroke="#0F1115" stroke-width="2" visibility="hidden"/>' +
      '<text x="' + L + '" y="' + (H - 6) + '" font-size="11" fill="#5B6070">' + niceDate(series[0][0], false) + '</text>' +
      '<text x="' + (W - R) + '" y="' + (H - 6) + '" font-size="11" fill="#5B6070" text-anchor="end">' + niceDate(last[0], false) + '</text>' +
      '</svg><span class="tip" hidden></span></div>';
  }
  function wireChart(root) {
    var el = root.querySelector('.chart');
    if (!el) return;
    var series = JSON.parse(el.getAttribute('data-series'));
    var svg = el.querySelector('svg'), cross = el.querySelector('.cross'), dot = el.querySelector('.dot-h'), tip = el.querySelector('.tip');
    var poly = el.querySelector('polyline').getAttribute('points').split(' ').map(function (p) { return p.split(',').map(Number); });
    function show(e) {
      var box = svg.getBoundingClientRect();
      var x = (e.clientX - box.left) / box.width * 340, best = 0;
      poly.forEach(function (p, i) { if (Math.abs(p[0] - x) < Math.abs(poly[best][0] - x)) best = i; });
      var p = poly[best];
      cross.setAttribute('x1', p[0]); cross.setAttribute('x2', p[0]); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', p[0]); dot.setAttribute('cy', p[1]); dot.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.textContent = niceDate(series[best][0], false) + ': ' + money(series[best][1]);
      var px = p[0] / 340 * box.width;
      tip.style.left = Math.max(48, Math.min(box.width - 48, px)) + 'px';
    }
    function hide() { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; }
    el.addEventListener('pointermove', show);
    el.addEventListener('pointerdown', show);
    el.addEventListener('pointerleave', hide);
  }
  function chartBlock(series) {
    var rows = series.slice().reverse().map(function (s) { return '<tr><td>' + niceDate(s[0]) + '</td><td>' + money(s[1]) + '</td></tr>'; }).join('');
    return '<section class="block"><h2>TCGplayer market price <span>' + niceDate(series[0][0], false) + ' to ' + niceDate(series[series.length - 1][0], false) + '</span></h2>' + chart(series) +
      (series.length > 1 ? '<details class="points"><summary>Show all ' + series.length + ' price readings</summary><table>' + rows + '</table></details>' : '') + '</section>';
  }

  function breakdown(p, days) {
    function row(label, value) { return '<div class="rowb"><dt>' + label + '</dt><dd>' + value + '</dd></div>'; }
    var rows = [];
    if (p.ch7 != null) rows.push(row('Last ' + days + ' days', move(p.ch7)));
    if (p.ch30 != null) rows.push(row('30 days', move(p.ch30)));
    if (p.ch90 != null) rows.push(row('90 days', move(p.ch90)));
    var gap = p.low / p.price - 1, g = Math.round(Math.abs(gap) * 100);
    rows.push(row('Cheapest listing', g === 0 ? 'At market' : g + '% ' + (gap < 0 ? 'under market' : 'over market')));
    if (p.activity != null && p.ch7 != null) rows.push(row('Trading', p.activity >= 0.6 ? 'Busy' : (p.activity >= 0.34 ? 'Regular' : 'Light')));
    return rows.join('');
  }

  function soldBlocks(p) {
    if (!p.sold) return '';
    var out = '', ebay = p.sold.ebay || {}, tcg = p.sold.tcgplayer || {};
    var order = ['UNOPENED', 'NEAR_MINT', 'LIGHTLY_PLAYED', 'MODERATELY_PLAYED', 'HEAVILY_PLAYED', 'DAMAGED'];
    var rankOf = function (k) { var i = order.indexOf(k); return i < 0 ? 99 : i; };
    var keys = function (o) { return Object.keys(o).filter(function (k) { return rankOf(k) < 99; }).sort(function (a, b) { return rankOf(a) - rankOf(b); }); };
    var on = function (t) { return t.last ? niceDate(t.last) : ''; };
    var ek = keys(ebay);
    if (ek.length) {
      var t = ebay[ek[0]];
      var m30 = t.median30d != null ? t.median30d : t.avg30d, m7 = t.median7d != null ? t.median7d : t.avg7d;
      var versus = m30 != null ? m30 : t.avg;
      out += '<section class="block"><h2>eBay sold <span>' + esc(tierName(ek[0])) + (p.kind === 'sealed' ? '' : ', raw') + '</span></h2><div class="figs">' +
        '<div><small>Latest sold</small><b>' + money(t.avg, true) + '</b><span>' + (on(t) || 'date not given') + '</span></div>' +
        '<div><small>30-day median</small><b>' + (m30 != null ? money(m30, true) : 'n/a') + '</b><span>' + (m7 != null ? '7 days: ' + money(m7, true) : '') + '</span></div>' +
        '<div><small>Sales counted</small><b>' + (t.saleCount != null ? (t.approxSaleCount ? 'about ' : '') + Number(t.saleCount).toLocaleString('en-US') : 'n/a') + '</b><span>' + (versus != null && p.price ? pct(versus / p.price - 1) + ' vs TCGplayer' : '') + '</span></div></div>';
      if (ek.length > 1) {
        out += '<table class="cond" style="margin-top:14px"><tr><th>Other conditions on eBay</th><th>Latest sold</th><th>Sales</th></tr>' + ek.slice(1).map(function (k) {
          return '<tr><td>' + esc(tierName(k)) + '</td><td>' + money(ebay[k].avg) + '</td><td class="muted">' + (ebay[k].saleCount != null ? ebay[k].saleCount : '') + '</td></tr>';
        }).join('') + '</table>';
      }
      out += '</section>';
    } else {
      out += '<section class="block sunk"><h2>eBay sold</h2><p class="note">No eBay sales on record for this item in the feed. The button at the bottom opens the live sold listings on eBay.</p></section>';
    }
    var tk = keys(tcg);
    if (tk.length) {
      out += '<section class="block sunk"><h2>TCGplayer sales' + (p.kind === 'sealed' ? '' : ' by condition') + ' <span>latest day, 30-day average</span></h2><table class="cond"><tr><th>' + (p.kind === 'sealed' ? 'Product' : 'Condition') + '</th><th>Latest</th><th>30-day avg</th><th>Sales</th></tr>' + tk.map(function (k) {
        return '<tr><td>' + esc(tierName(k)) + '</td><td>' + money(tcg[k].avg) + '</td><td class="muted">' + (tcg[k].avg30d != null ? money(tcg[k].avg30d) : '') + '</td><td class="muted">' + (tcg[k].saleCount != null ? Number(tcg[k].saleCount).toLocaleString('en-US') : '') + '</td></tr>';
      }).join('') + '</table></section>';
    }
    return out;
  }

  function buyLinks(name, number, abbr, url) {
    var ebay = 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent([shortName(name), number ? String(number).split('/')[0] : '', abbr || ''].join(' ').trim()) + '&LH_Sold=1&LH_Complete=1';
    return '<div class="buy"><a href="' + esc(url) + '" target="_blank" rel="noopener">View on TCGplayer</a><a class="alt" href="' + esc(ebay) + '" target="_blank" rel="noopener">eBay sold listings</a></div>';
  }

  function cardView(ctx, listId, rank) {
    var issue = ctx.issue, b = base(ctx), days = span(issue);
    var cat = issue.categories.filter(function (c) { return c.id === listId; })[0];
    var p = cat && cat.picks.filter(function (x) { return String(x.rank) === String(rank); })[0];
    if (!p) return notFound();

    var graded = '';
    if (p.graded) {
      var slabs = [['psa10', 'PSA 10'], ['psa9', 'PSA 9'], ['psa8', 'PSA 8']].filter(function (g) { return p.graded[g[0]]; }).map(function (g) {
        var d = p.graded[g[0]];
        return '<div><small>' + g[1] + '</small><b>' + money(d.price, true) + '</b><span>' + (d.confidence ? esc(d.confidence) + ' confidence' : '') + '</span></div>';
      });
      if (slabs.length) graded = '<section class="block tint"><h2>Graded, eBay sold <span>PSA</span></h2><div class="figs' + (slabs.length === 2 ? ' two' : '') + '">' + slabs.join('') + '</div></section>';
    }
    var prev = cat.picks[p.rank - 2], next = cat.picks[p.rank];
    var listHref = b + '/list/' + cat.id;
    var hrefOf = function (x) { return b + '/card/' + cat.id + '/' + x.rank; };
    swipe.prev = prev ? hrefOf(prev) : listHref;
    swipe.next = next ? hrefOf(next) : listHref;
    var confText = { High: 'it trades often, has a full price history and its listings match the market price', Medium: 'its history is partial or its listings sit a little off the market price', Low: 'its history is thin or its listings sit far from the market price' }[p.confidence];
    var price = money(p.price);

    return '<div class="' + tone(cat) + '"><header class="entry-head band"><a class="back" href="' + listHref + '">' + esc(cat.short || cat.title) + '</a>' +
      '<span class="eyebrow"><i class="dot"></i>Pick ' + p.rank + ' of ' + cat.picks.length + '</span><h1>' + esc(shortName(p.name)) + '</h1>' +
      '<p class="where">' + esc(where(p)) + (p.rarity ? '. ' + esc(p.rarity) : '') + '</p>' +
      (p.era ? '<div class="tags">' + eraChip(p.era) + '</div>' : '') + '</header>' +
      '<div class="entry-main">' + img(p, 'card-img', true) +
      '<div class="entry-price"><span class="eyebrow">TCGplayer market price</span><div class="big' + (price.length > 7 ? ' long' : '') + '">' + price + '</div>' +
      '<p class="sub">Lowest listing ' + money(p.low) + '</p>' +
      '<span class="conf ' + p.confidence.toLowerCase() + '">' + esc(p.confidence) + ' confidence</span></div></div>' +
      '<section class="verdict"><div class="num"><b>' + p.score + '</b><small>' + esc(p.scoreLabel) + ' score</small><em>' + verdict(p) + '</em></div>' +
      '<dl>' + breakdown(p, days) + '</dl></section>' +
      '<section class="block tint"><h2>Why it made the issue</h2><p class="why">' + esc(p.reason) + '</p></section>' +
      soldBlocks(p) + graded + chartBlock(p.series) +
      '<p class="note fine">Raw price: TCGplayer market price for the ' + esc(p.printing) + ' printing, via <a href="https://tcgcsv.com/" rel="noopener">TCGCSV</a>, pulled ' + niceDate(issue.date) + '. ' +
      (p.sold ? 'eBay sold and by-condition figures: <a href="https://poketrace.com/" rel="noopener">PokeTrace</a>, pulled ' + niceDate(p.sold.date) + '; eBay sale counts are approximate. ' : '') +
      (p.graded ? 'Graded prices: completed eBay sales via <a href="https://www.pokemonpricetracker.com/" rel="noopener">PokemonPriceTracker</a>, pulled ' + niceDate(p.graded.date) + '; they may mix printings, so check the slab matches this one. ' : '') +
      esc(p.confidence) + ' confidence means ' + confText + '. Not financial advice.</p>' +
      buyLinks(p.name, p.number, p.setAbbr, p.url) +
      '<nav class="pager" aria-label="Picks">' +
      '<a class="prev" href="' + (prev ? hrefOf(prev) : listHref) + '"><small>' + (prev ? 'Previous pick' : 'Back to') + '</small><b>' + esc(prev ? shortName(prev.name) : (cat.short || cat.title)) + '</b></a>' +
      '<a class="next" href="' + (next ? hrefOf(next) : listHref) + '"><small>' + (next ? 'Next pick' : 'Back to') + '</small><b>' + esc(next ? shortName(next.name) : (cat.short || cat.title)) + '</b></a></nav>' +
      '<p class="swipe-hint">Swipe left or right for the next pick.</p></div>';
  }

  // ---------- search ----------
  var S = { q: '', sort: 'best', type: '', era: '', set: '', rarity: '', printing: '', min: '', max: '', open: false, limit: 60 };
  var SORTS = [['best', 'Best match'], ['price-desc', 'Price, high to low'], ['price-asc', 'Price, low to high'], ['up30', 'Biggest 30-day rise'], ['down30', 'Biggest 30-day fall'], ['name', 'Name, A to Z'], ['new', 'Newest set first'], ['num', 'Card number']];
  function plain(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036F]/g, '').replace(/[\u2018\u2019]/g, "'"); }
  // Splits what was typed into terms. "quoted words" must match exactly as whole words;
  // a leading minus leaves matches out; anything else matches anywhere in the name, set or number.
  function parseQuery(raw) {
    var q = plain(raw).replace(/[\u201C\u201D\u201E\u2033]/g, '"');
    var re = /(-?)"([^"]*)(?:"|$)|(\S+)/g, m, terms = [];
    while ((m = re.exec(q))) {
      if (m[2] != null) {
        var phrase = m[2].trim().replace(/\s+/g, ' ');
        if (phrase) terms.push({ text: phrase, not: m[1] === '-', re: new RegExp('(^|[^a-z0-9])' + phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])') });
      } else {
        var not = m[3].length > 1 && m[3].charAt(0) === '-';
        terms.push({ text: not ? m[3].slice(1) : m[3], not: not, re: null });
      }
    }
    return terms;
  }
  function options(list, current) {
    return list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(current) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
  }
  function searchView() {
    return '<div class="search-box"><input id="q" type="search" inputmode="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Search a card, set or number" aria-label="Search cards and sealed products" value="' + esc(S.q) + '">' +
      '<div class="search-tools"><button type="button" id="f-toggle" aria-expanded="' + (S.open ? 'true' : 'false') + '" aria-controls="filters">Filters<span id="f-n"></span></button>' +
      '<label class="sort"><span>Sort</span><select id="f-sort">' + options(SORTS, S.sort) + '</select></label></div>' +
      '<div class="count" id="q-count" aria-live="polite"></div></div>' +
      '<section class="block filters" id="filters"' + (S.open ? '' : ' hidden') + '><div class="f-grid">' +
      '<label><span>Type</span><select id="f-type">' + options([['', 'Cards and sealed'], ['single', 'Single cards'], ['sealed', 'Sealed products']], S.type) + '</select></label>' +
      '<label><span>Era</span><select id="f-era"></select></label>' +
      '<label class="wide"><span>Set</span><select id="f-set"></select></label>' +
      '<label><span>Rarity</span><select id="f-rarity"></select></label>' +
      '<label><span>Printing</span><select id="f-printing"></select></label>' +
      '<label><span>Lowest price</span><input id="f-min" type="number" inputmode="decimal" min="0" step="any" placeholder="$ any" value="' + esc(S.min) + '"></label>' +
      '<label><span>Highest price</span><input id="f-max" type="number" inputmode="decimal" min="0" step="any" placeholder="$ any" value="' + esc(S.max) + '"></label></div>' +
      '<p class="note">Put words in quotes for an exact match: <b>"mew ex"</b> finds Mew ex but not Mewtwo ex. Put a minus in front of a word to leave it out: <b>charizard -vmax</b>.</p>' +
      '<button type="button" id="f-clear">Clear filters</button></section>' +
      '<ul class="results" id="q-results"></ul><div class="more" id="q-more" hidden><button type="button">Show more</button></div>';
  }
  function wireSearch() {
    var $ = function (id) { return document.getElementById(id); };
    var input = $('q'), list = $('q-results'), count = $('q-count'), more = $('q-more');
    if (!input) return;
    var timer = null, data = null;
    var fields = { sort: $('f-sort'), type: $('f-type'), era: $('f-era'), set: $('f-set'), rarity: $('f-rarity'), printing: $('f-printing'), min: $('f-min'), max: $('f-max') };
    var filterKeys = ['type', 'era', 'set', 'rarity', 'printing', 'min', 'max'];
    function activeFilters() { return filterKeys.filter(function (k) { return S[k] !== ''; }).length; }

    function fillSets() {
      var groups = {};
      data.sets.forEach(function (s, i) {
        if (!data.setCount[i]) return;
        var era = data.setEra[i] || 'other';
        if (S.era && era !== S.era) return;
        (groups[era] = groups[era] || []).push([s[0], s[1]]);
      });
      var html = '<option value="">All sets</option>';
      ERA_STARTS.slice().reverse().map(function (e) { return e[0]; }).concat(['other']).forEach(function (era) {
        if (groups[era]) html += '<optgroup label="' + esc(ERAS[era] ? ERAS[era][0] : 'Other') + '">' + options(groups[era], S.set) + '</optgroup>';
      });
      fields.set.innerHTML = html;
      if (S.set && fields.set.value !== String(S.set)) S.set = '';
    }
    function fillAll() {
      fields.era.innerHTML = options([['', 'All eras']].concat(ERA_STARTS.slice().reverse().map(function (e) { return [e[0], ERAS[e[0]][0]]; })), S.era);
      fields.rarity.innerHTML = options([['', 'Any rarity']].concat(data.rarities.map(function (r) { return [r, r]; })), S.rarity);
      fields.printing.innerHTML = options([['', 'Any printing']].concat(data.printings.map(function (r) { return [r, r]; })), S.printing);
      fillSets();
    }

    function run() {
      var terms = parseQuery(S.q), wanted = terms.filter(function (t) { return !t.not; });
      var n = activeFilters();
      $('f-n').textContent = n ? ' (' + n + ')' : '';
      $('f-clear').hidden = !n;
      var typed = wanted.some(function (t) { return t.text.length >= 2; });
      if (!typed && !n) {
        list.innerHTML = ''; more.hidden = true;
        count.textContent = Number(data.items.length).toLocaleString('en-US') + ' products, prices as of ' + niceDate(data.date) + '. Type a name, or open Filters to browse a set.';
        return;
      }
      var min = S.min === '' ? null : +S.min, max = S.max === '' ? null : +S.max;
      var hits = [];
      for (var i = 0; i < data.items.length; i++) {
        var it = data.items[i];
        if (S.type && (S.type === 'sealed') !== !!it[4]) continue;
        if (S.set && String(data.sets[it[2]][0]) !== String(S.set)) continue;
        if (S.era && data.setEra[it[2]] !== S.era) continue;
        if (S.rarity && it[5] !== S.rarity) continue;
        var pr = it[6][0];
        if (S.printing) {
          pr = null;
          for (var k = 0; k < it[6].length; k++) if (it[6][k][0] === S.printing) { pr = it[6][k]; break; }
          if (!pr) continue;
        }
        if (min != null && pr[1] < min) continue;
        if (max != null && pr[1] > max) continue;
        var h = data.hay[i], ok = true;
        for (var t = 0; t < terms.length; t++) {
          var found = terms[t].re ? terms[t].re.test(h) : h.indexOf(terms[t].text) >= 0;
          if (found === terms[t].not) { ok = false; break; }
        }
        if (ok) hits.push([i, pr]);
      }
      var first = wanted.length ? wanted[0].text : null;
      var starts = function (x) { return first && plain(data.items[x[0]][1]).indexOf(first) === 0 ? 1 : 0; };
      var byPrice = function (a, b) { return b[1][1] - a[1][1]; };
      var num = function (x) { var m = /\d+/.exec(data.items[x[0]][3] || ''); return m ? +m[0] : 1e9; };
      var sorters = {
        'best': function (a, b) { return starts(b) - starts(a) || byPrice(a, b); },
        'price-desc': byPrice,
        'price-asc': function (a, b) { return a[1][1] - b[1][1]; },
        'up30': function (a, b) { return (b[1][4] == null ? -9 : b[1][4]) - (a[1][4] == null ? -9 : a[1][4]) || byPrice(a, b); },
        'down30': function (a, b) { return (a[1][4] == null ? 9 : a[1][4]) - (b[1][4] == null ? 9 : b[1][4]) || byPrice(a, b); },
        'name': function (a, b) { return data.items[a[0]][1].localeCompare(data.items[b[0]][1]) || byPrice(a, b); },
        'new': function (a, b) { return data.items[a[0]][2] - data.items[b[0]][2] || byPrice(a, b); },
        'num': function (a, b) { return data.items[a[0]][2] - data.items[b[0]][2] || num(a) - num(b) || byPrice(a, b); }
      };
      hits.sort(sorters[S.sort] || sorters.best);
      var shown = Math.min(hits.length, S.limit);
      count.textContent = hits.length === 0 ? 'No matches. Try fewer words, remove the quotes, or clear a filter.' :
        (hits.length > shown ? 'Showing ' + shown + ' of ' + Number(hits.length).toLocaleString('en-US') + ' matches.' : hits.length + (hits.length === 1 ? ' match.' : ' matches.'));
      more.hidden = hits.length <= shown;
      list.innerHTML = hits.slice(0, shown).map(function (hit) {
        var it = data.items[hit[0]], s = data.sets[it[2]], pr = hit[1], era = data.setEra[it[2]];
        var meta = [s[1], it[3] ? '#' + it[3] : '', pr[0] !== 'Normal' ? pr[0] : '', !S.printing && it[6].length > 1 ? '+' + (it[6].length - 1) + ' more' : ''].filter(Boolean).join(', ');
        return '<li class="' + eraTone(era) + '"><a href="#/p/' + s[0] + '/' + it[0] + '/' + encodeURIComponent(pr[0]) + '"><img src="' + productImage(it[0]) + '" alt="" loading="lazy">' +
          '<span><b>' + esc(it[1]) + '</b><small>' + esc(meta) + '</small><span class="tags">' + eraChip(era) + (it[5] && !it[4] ? '<span class="rar">' + esc(it[5]) + '</span>' : '') + '</span></span>' +
          '<span class="r"><span class="price">' + money(pr[1]) + '</span>' + (pr[4] != null ? move(pr[4]) : '') + '</span></a></li>';
      }).join('');
    }
    function changed(resetLimit) { if (resetLimit !== false) S.limit = 60; if (data) run(); }

    count.textContent = 'Loading the product list.';
    getSearch().then(function (d) {
      data = d;
      fillAll();
      run();
    }).catch(function () { count.textContent = 'The product list could not be loaded. Check your connection and reload.'; });

    input.addEventListener('input', function () { S.q = input.value; clearTimeout(timer); timer = setTimeout(changed, 120); });
    Object.keys(fields).forEach(function (k) {
      fields[k].addEventListener(k === 'min' || k === 'max' ? 'input' : 'change', function () {
        S[k] = fields[k].value;
        if (k === 'era' && data) fillSets();
        changed();
      });
    });
    $('f-toggle').addEventListener('click', function () {
      S.open = !S.open;
      $('filters').hidden = !S.open;
      this.setAttribute('aria-expanded', S.open ? 'true' : 'false');
    });
    $('f-clear').addEventListener('click', function () {
      filterKeys.forEach(function (k) { S[k] = ''; if (fields[k].tagName === 'INPUT') fields[k].value = ''; });
      if (data) fillAll();
      fields.type.value = '';
      changed();
    });
    more.querySelector('button').addEventListener('click', function () { S.limit += 60; changed(false); });
    if (!S.q && !activeFilters() && window.matchMedia('(hover: hover)').matches) input.focus();
  }

  function productView(gid, pid, printing) {
    return Promise.all([getSearch(), getSet(gid)]).then(function (res) {
      var data = res[0], hist = res[1];
      var it = data.items.filter(function (x) { return String(x[0]) === String(pid); })[0];
      if (!it) return notFound();
      var s = data.sets[it[2]], era = data.setEra[it[2]];
      var pr = it[6].filter(function (x) { return x[0] === printing; })[0] || it[6][0];
      var series = [];
      if (hist) {
        var arr = hist.series[pid + '|' + pr[0]] || [];
        hist.dates.forEach(function (d, i) { if (arr[i]) series.push([d, arr[i]]); });
      }
      if (!series.length) series = [[data.date, pr[1]]];
      var first = series[0], q = null;
      var cutoff = new Date(Date.parse(data.date) - 100 * 864e5).toISOString().slice(0, 10);
      if (series.length > 1 && first[0] >= cutoff) q = pr[1] / first[1] - 1;
      var price = money(pr[1]);
      var chips = it[6].length > 1 ? '<div class="printings">' + it[6].map(function (x) {
        return '<a href="#/p/' + gid + '/' + pid + '/' + encodeURIComponent(x[0]) + '"' + (x[0] === pr[0] ? ' aria-current="true"' : '') + '>' + esc(x[0]) + '</a>';
      }).join('') + '</div>' : '';
      var pick = { name: it[1], image: productImage(it[0]), kind: it[4] ? 'sealed' : 'single' };
      var rows = [];
      if (pr[3] != null) rows.push('<div><small>Short term</small><b>' + move(pr[3]) + '</b></div>');
      if (pr[4] != null) rows.push('<div><small>30 days</small><b>' + move(pr[4]) + '</b></div>');
      if (q != null) rows.push('<div><small>Since ' + niceDate(first[0], false) + '</small><b>' + move(q) + '</b></div>');
      swipe.prev = swipe.next = null;
      return '<div class="' + (eraTone(era) || 't-steady') + '"><header class="entry-head band"><a class="back" href="#/search">Search</a>' +
        '<span class="eyebrow"><i class="dot"></i>' + (it[4] ? 'Sealed product' : 'Single card') + '</span><h1>' + esc(shortName(it[1])) + '</h1>' +
        '<p class="where">' + esc([s[1], it[3] ? '#' + it[3] : '', it[5] || ''].filter(Boolean).join(', ')) + '</p>' +
        (era ? '<div class="tags">' + eraChip(era) + '</div>' : '') + '</header>' +
        '<div class="entry-main">' + img(pick, 'card-img', true) +
        '<div class="entry-price"><span class="eyebrow">TCGplayer market price</span><div class="big' + (price.length > 7 ? ' long' : '') + '">' + price + '</div>' +
        '<p class="sub">' + (pr[2] != null ? 'Lowest listing ' + money(pr[2]) : 'Nothing listed right now') + '</p>' + chips + '</div></div>' +
        (rows.length ? '<section class="block tint"><h2>Price moves</h2><div class="figs' + (rows.length === 2 ? ' two' : '') + '">' + rows.join('') + '</div></section>' : '') +
        chartBlock(series) +
        '<p class="note fine">TCGplayer market price for the ' + esc(pr[0]) + ' printing, via <a href="https://tcgcsv.com/" rel="noopener">TCGCSV</a>, as of ' + niceDate(data.date) + '. eBay sold and graded prices are looked up only for cards in the weekly issue.</p>' +
        buyLinks(it[1], it[3], s[2], 'https://www.tcgplayer.com/product/' + it[0]) + '</div>';
    });
  }

  function issuesView(ctx) {
    var rows = ctx.index.map(function (e) {
      return '<a class="issue-row" href="#/issue/' + e.number + '/"><img src="' + esc(e.coverImage || PLACEHOLDER) + '" alt="" loading="lazy">' +
        '<span><b>Issue ' + pad(e.number, 2) + '</b><span>Week of ' + niceDate(e.date) + '. ' + e.picks + ' picks. Top pick: ' + esc(shortName(e.coverName || '')) + '</span></span></a>';
    }).join('');
    return '<header class="page-head"><h1>Back issues</h1></header><section class="block">' + rows + '</section>' +
      '<section class="block sunk article"><p>A new issue is cut every Thursday night, ready for Friday morning. Once four weeks of issues exist, each back issue will show how its picks did.</p></section>';
  }

  function howView(ctx) {
    var issue = ctx.issue, days = span(issue);
    var rules = issue.categories.map(function (c) { return '<li class="' + tone(c) + '"><i class="dot"></i><b>' + esc(c.title) + '.</b> ' + esc(c.rule) + '</li>'; }).join('');
    var sources = issue.sources.map(function (s) { return '<li><a href="' + esc(s.url) + '" rel="noopener">' + esc(s.name) + '</a>. ' + esc(s.note) + '</li>'; }).join('');
    return '<header class="page-head"><h1>How it works</h1>' +
      '<p class="deck">Every day a job copies the TCGplayer market price of every English Pokémon single and sealed product, about ' + Number(issue.stats.productsScanned).toLocaleString('en-US') +
      ' products. Once a week it compares today with a week, 30 days and 90 days ago and runs the rules below. Nothing is hand-picked.</p></header>' +
      (days !== 7 ? '<section class="block tint t-sale article"><p>This issue measures its short-term move over ' + days + ' days instead of 7, because the free price archive has a gap in late September 2026. From the next issue on it is a true 7-day move.</p></section>' : '') +
      '<section class="block article"><h2>Where the numbers come from</h2><ul>' + sources + '</ul></section>' +
      '<section class="block article"><h2>The rule for each list</h2><ul style="list-style:none;padding-left:0">' + rules + '</ul></section>' +
      '<section class="block sunk article"><h2>Checks on every pick</h2><ul>' +
      '<li>It must have a sales-based market price today and at least one copy listed for sale now.</li>' +
      '<li>It must actually trade. The job checks how often the market price changed across the readings on file. A price that never moves usually means no sales, and those cards are left out.</li>' +
      '<li>For rising picks, the lowest current listing must sit between 30% under and 25% over the market price, so the move is backed by what sellers are asking and you can buy near the quoted price.</li>' +
      '<li>A short-term move above 300% is treated as a data error and dropped.</li>' +
      '<li>At most three picks per set in a list, no card appears in two lists, and presale products are left out.</li></ul></section>' +
      '<section class="block dark article"><h2>Scores and confidence</h2><p>The Heat score (1 to 99) blends the short-term and 30-day moves. Deal scores measure a discount, either to the 90-day median or, for sealed products without a history yet, to the market price. Steady scores measure how tight the price band is. Swing scores measure the size of a move in either direction. Rebound scores blend how far a card dipped, how well it held up before the dip and how often it trades; they describe a setup, not a forecast. Confidence is High when the card trades often, has a full price history and its listings match the market price.</p></section>' +
      '<section class="block article"><h2>What this free version cannot see</h2><ul>' +
      '<li>Individual eBay sales. eBay sold figures are the latest sold price, medians and counts for the cards in the issue, not a list of each sale. The "eBay sold listings" button on every card opens the live list on eBay.</li>' +
      '<li>Whole-catalog sales counts. Picks are screened on price movement; sale counts are shown for the picks themselves.</li>' +
      '<li>Sealed trends before October 2026. The history seed covers singles only, so the sealed list ranks by listing discount until a week of sealed prices exists.</li>' +
      '<li>Reddit and X chatter. Not connected yet.</li></ul></section>' +
      '<section class="block sunk article"><h2>The fine print</h2><p>This is market information, not financial advice. A price that rose last week can fall next week. Not affiliated with or endorsed by Nintendo, The Pokémon Company, TCGplayer or eBay. Card images are shown only to identify the cards being priced.</p></section>';
  }

  function notFound() { return '<p class="empty">That page is not in this issue. <a href="#/">Go to the front page</a>.</p>'; }

  // ---------- router ----------
  function setNav(name) {
    document.querySelectorAll('.nav a').forEach(function (a) {
      if (a.getAttribute('data-nav') === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  function show(html) {
    var from = slideFrom;
    slideFrom = null;
    screen.style.transition = 'none';
    screen.style.transform = '';
    screen.style.opacity = '';
    screen.innerHTML = html;
    wireChart(screen);
    window.scrollTo(0, 0);
    if (from && !reduceMotion) {
      // New page glides in from the side the finger was heading to.
      screen.style.transform = 'translateX(' + (from === 'right' ? 36 : -36) + 'px)';
      screen.style.opacity = '0';
      void screen.offsetWidth;
      screen.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1), opacity .18s ease-out';
      screen.style.transform = '';
      screen.style.opacity = '';
    }
  }
  function fail(err) {
    show(err && err.message === 'empty'
      ? '<p class="empty">The first issue has not been built yet. It appears here after the data job runs.</p>'
      : '<p class="empty">Could not load this page. Check your connection and reload.</p>');
  }
  function route() {
    var parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    var number = null;
    if (parts[0] === 'issue') { number = parseInt(parts[1], 10) || null; parts = parts.slice(2); }
    var view = parts[0] || 'front';
    swipe.prev = swipe.next = null;

    if (view === 'search') {
      setNav('search'); tabsEl.hidden = true;
      show(searchView()); wireSearch();
      document.title = 'Search, Pokédex weekly';
      return;
    }
    if (view === 'p') {
      setNav('search'); tabsEl.hidden = true;
      productView(parts[1], parts[2], decodeURIComponent(parts[3] || '')).then(show).catch(fail);
      return;
    }
    getIssue(number).then(function (ctx) {
      issueNoEl.textContent = 'Issue ' + pad(ctx.issue.number, 2) + ', ' + niceDate(ctx.issue.date, false);
      var html;
      if (view === 'list') { setNav('issue'); renderTabs(ctx, parts[1]); html = listView(ctx, parts[1]); }
      else if (view === 'card') { setNav('issue'); renderTabs(ctx, parts[1]); html = cardView(ctx, parts[1], parts[2]); }
      else if (view === 'issues') { setNav('issues'); tabsEl.hidden = true; html = issuesView(ctx); }
      else if (view === 'how') { setNav('how'); tabsEl.hidden = true; html = howView(ctx); }
      else { setNav('issue'); renderTabs(ctx, ''); html = frontView(ctx); if (!route.warmed) { route.warmed = true; setTimeout(function () { new Image().src = 'img/guide.webp'; }, 1500); } }
      show(html);
      document.title = ctx.issue.title + ' weekly, issue ' + ctx.issue.number;
    }).catch(fail);
  }

  // ---------- swipe ----------
  // The page follows the finger. Past a short distance, or on a quick flick, it slides away
  // and the next section or pick glides in; otherwise it settles back.
  var drag = null, noClickUntil = 0;
  // A sideways drag must never also count as a tap on the card under the finger.
  document.addEventListener('click', function (e) {
    if (Date.now() < noClickUntil) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  function settle() {
    screen.style.transition = 'transform .18s cubic-bezier(.2,.8,.2,1), opacity .18s';
    screen.style.transform = '';
    screen.style.opacity = '';
  }
  screen.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1 || e.target.closest('.chart, input, .tabs, details[open] table')) { drag = null; return; }
    drag = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), dx: 0, lock: null };
  }, { passive: true });
  screen.addEventListener('touchmove', function (e) {
    if (!drag) return;
    var dx = e.touches[0].clientX - drag.x, dy = e.touches[0].clientY - drag.y;
    if (drag.lock === null) {
      if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
      drag.lock = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
      if (drag.lock === 'x') screen.style.transition = 'none';
    }
    if (drag.lock !== 'x') return;
    drag.dx = dx;
    var target = dx < 0 ? swipe.next : swipe.prev;
    // With nowhere to go, the page resists instead of following.
    screen.style.transform = 'translateX(' + (target ? dx : dx * 0.22) + 'px)';
    screen.style.opacity = target ? String(1 - Math.min(0.45, Math.abs(dx) / 520)) : '';
  }, { passive: true });
  function release() {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (d.lock !== 'x') return;
    if (Math.abs(d.dx) > 10) noClickUntil = Date.now() + 350;
    var dx = d.dx, speed = Math.abs(dx) / Math.max(1, Date.now() - d.t);
    var target = dx < 0 ? swipe.next : swipe.prev;
    var commit = target && (Math.abs(dx) > 44 || (speed > 0.3 && Math.abs(dx) > 14));
    if (!commit) { settle(); return; }
    if (reduceMotion) { location.hash = target; return; }
    slideFrom = dx < 0 ? 'right' : 'left';
    screen.style.transition = 'transform .12s ease-in, opacity .12s ease-in';
    screen.style.transform = 'translateX(' + (dx < 0 ? -60 : 60) + '%)';
    screen.style.opacity = '0';
    setTimeout(function () { location.hash = target; }, 110);
  }
  screen.addEventListener('touchend', release, { passive: true });
  screen.addEventListener('touchcancel', function () { if (drag && drag.lock === 'x') settle(); drag = null; }, { passive: true });
  // Arrow keys do the same on a keyboard.
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
    var target = e.key === 'ArrowRight' ? swipe.next : (e.key === 'ArrowLeft' ? swipe.prev : null);
    if (target) { slideFrom = e.key === 'ArrowRight' ? 'right' : 'left'; location.hash = target; }
  });

  // ---------- the strategy button ----------
  // Looks like the most useful button on the page. It is not.
  var WISDOM = [
    'Don\u2019t forget to give back to the community.',
    'Remember, it\u2019s all for the kids.',
    'Touch someone\u2019s heart today.',
    'The real pull is the friends we made along the way.',
    'Collect memories, not just cardboard.',
    'Be the holo you wish to see in the world.',
    'A booster shared is a booster doubled.',
    'It\u2019s not about the money. It\u2019s about the journey.',
    'Kindness is the rarest pull of all.',
    'Hug your local card shop owner.',
    'We rise by lifting others. And by grading.',
    'Somewhere a kid just pulled their first holo. That\u2019s the real market.',
    'Give a binder, change a life.',
    'Every card has a story. Listen to it.',
    'Invest in people. They never get reprinted.',
    'Open your heart like it\u2019s a booster box.',
    'I\u2019m just grateful to be on this journey with all of you.',
    'Humbled. Truly humbled.',
    'The hobby gave me everything. I\u2019m only here to give back.',
    'Profit fades. Community is forever.',
    'Before you check prices, check on a friend.',
    'I don\u2019t see a market. I see a family.',
    'Let\u2019s make space for every collector\u2019s truth.',
    'A gem mint heart can\u2019t be graded.',
    'Be someone\u2019s chase card today.',
    'I do this for the culture.',
    'Sleeve your cards. Sleeve your loved ones.',
    'Sending love and light to everyone who missed the restock.',
    'Your worth is not your collection\u2019s worth.',
    'Honored to hold space for this cardboard.',
    'We don\u2019t flip cards. We rehome them.',
    'Gratitude is the only grail.',
    'Thoughts and prayers for your pull rates.',
    'Leave every trade better than you found it.',
    'Tell a child they matter. Then tell them about set rotation.',
    'Abundance mindset. There\u2019s enough Charizard for all of us.',
    'I\u2019m not a collector. I\u2019m a steward.',
    'Lead with empathy. Follow with a fair offer.',
    'This isn\u2019t about me. It has never been about me.',
    'Blessed beyond measure. Also up 12%.',
    'Hold your loved ones like a first edition.',
    'Shop local. Love global.',
    'Every pack opened is a wish for a better world.',
    'I just want to inspire the next generation of collectors.',
    'Protect the hobby. Protect each other.',
    'Listening and learning. Always.',
    'Be the change. Keep the change. Donate the change.',
    'Passion over profit. Always. Mostly.',
    'Starting a conversation is the real strategy.',
    'May your centering be perfect and your heart be full.',
    'Do it for the love of the game.',
    'If one kid smiles, the spreadsheet was worth it.'
  ];
  var guide = null, guideTimer = null, lastLine = -1, bag = [];
  // Every line gets its turn before any repeats.
  function nextLine() {
    if (!bag.length) {
      bag = WISDOM.map(function (_, i) { return i; });
      for (var i = bag.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = bag[i]; bag[i] = bag[j]; bag[j] = t; }
      if (bag[bag.length - 1] === lastLine) bag.unshift(bag.pop());
    }
    lastLine = bag.pop();
    return WISDOM[lastLine];
  }
  function buildGuide() {
    guide = document.createElement('div');
    guide.className = 'guide';
    guide.innerHTML = '<p class="guide-say" role="status" aria-live="polite"></p><img src="img/guide.webp" alt="" width="220" height="246">';
    guide.addEventListener('click', hideGuide);
    document.body.appendChild(guide);
    void guide.offsetWidth;
  }
  function hideGuide() { clearTimeout(guideTimer); if (guide) guide.classList.remove('on'); }
  function speak() {
    if (!guide) buildGuide();
    guide.querySelector('.guide-say').textContent = nextLine();
    guide.classList.remove('on');
    void guide.offsetWidth;
    guide.classList.add('on');
    clearTimeout(guideTimer);
    guideTimer = setTimeout(hideGuide, 4200);
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#strategy')) speak();
  });

  window.addEventListener('hashchange', function () { hideGuide(); route(); });
  route();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
