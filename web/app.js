/* Pokédex weekly: renders the issue files written by the data job. No build step. */
(function () {
  'use strict';

  var screen = document.getElementById('screen');
  var tabsEl = document.getElementById('tabs');
  var issueNoEl = document.getElementById('issue-no');
  var cache = {};
  var indexPromise = null, searchPromise = null, setCache = {};
  var lastQuery = '';
  var swipe = { prev: null, next: null };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var TIERS = { NEAR_MINT: 'Near Mint', LIGHTLY_PLAYED: 'Lightly Played', MODERATELY_PLAYED: 'Moderately Played', HEAVILY_PLAYED: 'Heavily Played', DAMAGED: 'Damaged' };

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
        data.hay = data.items.map(function (it) {
          var s = data.sets[it[2]];
          return (it[1] + ' ' + s[1] + ' ' + (s[2] || '') + ' ' + (it[3] || '')).toLowerCase();
        });
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
    var tabs = [['', 'Front page']].concat(ctx.issue.categories.map(function (c) { return [c.id, c.short || c.title]; }));
    tabsEl.innerHTML = tabs.map(function (t) {
      return '<a href="' + b + (t[0] ? '/list/' + t[0] : '/') + '"' + (t[0] === activeId ? ' aria-current="true"' : '') + '>' + esc(t[1]) + '</a>';
    }).join('');
    tabsEl.hidden = false;
    var on = tabsEl.querySelector('[aria-current]');
    if (on) tabsEl.scrollLeft = Math.max(0, on.offsetLeft - (tabsEl.clientWidth - on.offsetWidth) / 2);
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
      return '<li class="tone-' + c.color + '"><a href="' + b + '/list/' + c.id + '">' +
        '<span><h3><i class="dot"></i>' + esc(listTitle(c)) + '</h3><p class="blurb">' + esc(c.blurb) + '</p>' +
        '<p class="lead-line"><b>' + esc(shortName(p.name)) + '</b><span class="price">' + money(p.price) + '</span>' + headlineMove(p) + '</p></span>' +
        img(p, 'thumb') + '</a></li>';
    }).join('');

    var s = issue.stats;
    return '<header class="front-head"><div class="dateline eyebrow"><span>Issue ' + pad(issue.number, 2) + '</span><span>Week of ' + niceDate(issue.date) + '</span></div>' +
      '<h1>This week&#39;s picks</h1>' +
      '<p class="deck">' + total + ' cards and sealed products worth a look, chosen by rule from ' + Number(s.productsScanned).toLocaleString('en-US') + ' tracked products.</p></header>' +
      '<a class="hero tone-' + coverCat.color + '" href="' + coverHref + '">' + img(coverPick, 'card-img', true) +
        '<span><span class="eyebrow"><i class="dot"></i>Top pick, ' + esc(coverCat.short || coverCat.title) + '</span>' +
        '<h2>' + esc(shortName(coverPick.name)) + '</h2><p class="where">' + esc(where(coverPick)) + '</p>' +
        '<span class="figures"><span class="price">' + money(coverPick.price) + '</span>' + headlineMove(coverPick) + '</span>' + score(coverPick) + '</span></a>' +
      '<p class="hero-why deck">' + esc(coverPick.reason) + '</p>' +
      '<section class="block"><h2>Sections <span>' + issue.categories.length + ' lists</span></h2></section>' +
      '<ol class="sections">' + sections + '</ol>' +
      '<div class="stats"><div><b>' + Number(s.productsScanned).toLocaleString('en-US') + '</b><span>products checked</span></div>' +
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
        '<div class="figures"><span class="price">' + money(p.price) + '</span>' + headlineMove(p) + '</div>' + score(p) + '</div></a>';
    }).join('');
    var trendNote = lead.ch7 != null ? 'Change shown is the ' + days + '-day move in TCGplayer market price, as of ' + niceDate(issue.date) + '.'
      : 'Prices are TCGplayer market prices and lowest listings as of ' + niceDate(issue.date) + '.';
    return '<div class="tone-' + cat.color + '"><header class="sec-head"><span class="eyebrow"><i class="dot"></i>Section ' + (idx + 1) + ' of ' + issue.categories.length + '</span>' +
      '<h1>' + esc(listTitle(cat)) + '</h1><p class="deck">' + esc(cat.blurb) + '</p></header>' +
      '<a class="lead" href="' + b + '/card/' + cat.id + '/' + lead.rank + '">' +
        '<div class="lead-art"><span class="rank">1</span>' + img(lead, 'card-img', true) + '</div>' +
        '<div><h2>' + esc(shortName(lead.name)) + '</h2><p class="where">' + esc(where(lead)) + '</p>' +
        '<div class="figures"><span class="price">' + money(lead.price) + '</span>' + headlineMove(lead) + '</div>' + score(lead) + '</div></a>' +
      '<p class="lead-why deck">' + esc(lead.reason) + '</p>' +
      '<div class="picks">' + rest + '</div>' +
      '<div class="aside"><b>How this list is picked</b><p>' + esc(cat.rule) + ' ' + cat.eligible + ' passed this week; these are the top ' + cat.picks.length + '.</p></div>' +
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
      '<polygon points="' + L + ',' + (H - B) + ' ' + pts.join(' ') + ' ' + X(last[0]).toFixed(1) + ',' + (H - B) + '" fill="#1F3FBF" opacity=".07"/>' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#1F3FBF" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + X(last[0]).toFixed(1) + '" cy="' + Y(last[1]).toFixed(1) + '" r="4" fill="#1F3FBF" stroke="#fff" stroke-width="2"/>' +
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
    var order = ['NEAR_MINT', 'LIGHTLY_PLAYED', 'MODERATELY_PLAYED', 'HEAVILY_PLAYED', 'DAMAGED'];
    var keys = function (o) { return Object.keys(o).sort(function (a, b) { return (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99; }); };
    var ek = keys(ebay);
    if (ek.length) {
      var t = ebay[ek[0]];
      var med = t.median7d != null ? t.median7d : t.avg7d, med30 = t.median30d != null ? t.median30d : t.avg30d;
      out += '<section class="block"><h2>eBay sold <span>' + esc(tierName(ek[0])) + ', raw</span></h2><div class="figs">' +
        '<div><small>Average sold</small><b>' + money(t.avg, true) + '</b><span>' + (t.low != null && t.high != null ? money(t.low, true) + ' to ' + money(t.high, true) : '') + '</span></div>' +
        '<div><small>Last 7 days</small><b>' + (med != null ? money(med, true) : 'n/a') + '</b><span>30 days: ' + (med30 != null ? money(med30, true) : 'n/a') + '</span></div>' +
        '<div><small>Sales counted</small><b>' + (t.saleCount != null ? (t.approxSaleCount ? 'about ' : '') + t.saleCount : 'n/a') + '</b><span>' + (t.avg != null && p.price ? pct(t.avg / p.price - 1) + ' vs TCGplayer' : '') + '</span></div></div>';
      if (ek.length > 1) {
        out += '<table class="cond" style="margin-top:12px"><tr><th>Other conditions on eBay</th><th>Avg sold</th><th>Sales</th></tr>' + ek.slice(1).map(function (k) {
          return '<tr><td>' + esc(tierName(k)) + '</td><td>' + money(ebay[k].avg) + '</td><td class="muted">' + (ebay[k].saleCount != null ? ebay[k].saleCount : '') + '</td></tr>';
        }).join('') + '</table>';
      }
      out += '</section>';
    }
    var tk = keys(tcg);
    if (tk.length) {
      out += '<section class="block"><h2>TCGplayer by condition <span>recent sales</span></h2><table class="cond"><tr><th>Condition</th><th>Avg sold</th><th>30-day avg</th><th>Sales</th></tr>' + tk.map(function (k) {
        return '<tr><td>' + esc(tierName(k)) + '</td><td>' + money(tcg[k].avg) + '</td><td class="muted">' + (tcg[k].avg30d != null ? money(tcg[k].avg30d) : '') + '</td><td class="muted">' + (tcg[k].saleCount != null ? tcg[k].saleCount : '') + '</td></tr>';
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
      if (slabs.length) graded = '<section class="block"><h2>Graded, eBay sold <span>PSA</span></h2><div class="figs' + (slabs.length === 2 ? ' two' : '') + '">' + slabs.join('') + '</div></section>';
    }
    var prev = cat.picks[p.rank - 2], next = cat.picks[p.rank];
    var listHref = b + '/list/' + cat.id;
    var hrefOf = function (x) { return b + '/card/' + cat.id + '/' + x.rank; };
    swipe.prev = prev ? hrefOf(prev) : listHref;
    swipe.next = next ? hrefOf(next) : listHref;
    var confText = { High: 'it trades often, has a full price history and its listings match the market price', Medium: 'its history is partial or its listings sit a little off the market price', Low: 'its history is thin or its listings sit far from the market price' }[p.confidence];
    var price = money(p.price);

    return '<div class="tone-' + cat.color + '"><a class="back" href="' + listHref + '">' + esc(cat.short || cat.title) + '</a>' +
      '<header class="entry-head"><span class="eyebrow">Pick ' + p.rank + ' of ' + cat.picks.length + '</span><h1>' + esc(shortName(p.name)) + '</h1>' +
      '<p class="where">' + esc(where(p)) + (p.rarity ? '. ' + esc(p.rarity) : '') + '</p></header>' +
      '<div class="entry-main">' + img(p, 'card-img', true) +
      '<div class="entry-price"><span class="eyebrow">TCGplayer market price</span><div class="big' + (price.length > 7 ? ' long' : '') + '">' + price + '</div>' +
      '<p class="sub">Lowest listing ' + money(p.low) + '</p>' +
      '<span class="conf ' + p.confidence.toLowerCase() + '">' + esc(p.confidence) + ' confidence</span></div></div>' +
      '<section class="verdict"><div class="num"><b>' + p.score + '</b><small>' + esc(p.scoreLabel) + ' score</small><em>' + verdict(p) + '</em></div>' +
      '<dl>' + breakdown(p, days) + '</dl></section>' +
      '<section class="block"><h2>Why it made the issue</h2><p class="why">' + esc(p.reason) + '</p></section>' +
      soldBlocks(p) + graded + chartBlock(p.series) +
      '<p class="note block">Raw price: TCGplayer market price for the ' + esc(p.printing) + ' printing, via <a href="https://tcgcsv.com/" rel="noopener">TCGCSV</a>, pulled ' + niceDate(issue.date) + '. ' +
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
  function searchView() {
    return '<div class="search-box"><input id="q" type="search" inputmode="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Search a card, set or number" aria-label="Search cards and sealed products" value="' + esc(lastQuery) + '">' +
      '<div class="count" id="q-count" aria-live="polite"></div></div><ul class="results" id="q-results"></ul>';
  }
  function wireSearch() {
    var input = document.getElementById('q'), list = document.getElementById('q-results'), count = document.getElementById('q-count');
    if (!input) return;
    var timer = null;
    function run(data) {
      var q = input.value.trim().toLowerCase();
      lastQuery = input.value;
      if (q.length < 2) {
        list.innerHTML = '';
        count.textContent = Number(data.items.length).toLocaleString('en-US') + ' products, prices as of ' + niceDate(data.date) + '. Type at least two letters.';
        return;
      }
      var tokens = q.split(/\s+/), hits = [];
      for (var i = 0; i < data.items.length; i++) {
        var h = data.hay[i], ok = true;
        for (var t = 0; t < tokens.length; t++) { if (h.indexOf(tokens[t]) < 0) { ok = false; break; } }
        if (ok) hits.push(i);
      }
      hits.sort(function (a, b) {
        var A = data.items[a], B = data.items[b];
        var sa = A[1].toLowerCase().indexOf(tokens[0]) === 0 ? 1 : 0, sb = B[1].toLowerCase().indexOf(tokens[0]) === 0 ? 1 : 0;
        return sb - sa || B[6][0][1] - A[6][0][1];
      });
      count.textContent = hits.length === 0 ? 'No matches. Try the card name plus the set, like "charizard evolutions".' :
        (hits.length > 60 ? 'Showing the 60 highest-priced of ' + Number(hits.length).toLocaleString('en-US') + ' matches.' : hits.length + (hits.length === 1 ? ' match.' : ' matches.'));
      list.innerHTML = hits.slice(0, 60).map(function (i) {
        var it = data.items[i], s = data.sets[it[2]], pr = it[6][0];
        var meta = [s[1], it[3] ? '#' + it[3] : '', pr[0] !== 'Normal' ? pr[0] : '', it[6].length > 1 ? '+' + (it[6].length - 1) + ' more' : ''].filter(Boolean).join(', ');
        return '<li><a href="#/p/' + s[0] + '/' + it[0] + '/' + encodeURIComponent(pr[0]) + '"><img src="' + productImage(it[0]) + '" alt="" loading="lazy">' +
          '<span><b>' + esc(it[1]) + '</b><small>' + esc(meta) + '</small></span>' +
          '<span class="r"><span class="price">' + money(pr[1]) + '</span>' + (pr[4] != null ? move(pr[4]) : '') + '</span></a></li>';
      }).join('');
    }
    count.textContent = 'Loading the product list.';
    getSearch().then(function (data) {
      run(data);
      input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { run(data); }, 120); });
    }).catch(function () { count.textContent = 'The product list could not be loaded. Check your connection and reload.'; });
    if (!lastQuery && window.matchMedia('(hover: hover)').matches) input.focus();
  }

  function productView(gid, pid, printing) {
    return Promise.all([getSearch(), getSet(gid)]).then(function (res) {
      var data = res[0], hist = res[1];
      var it = data.items.filter(function (x) { return String(x[0]) === String(pid); })[0];
      if (!it) return notFound();
      var s = data.sets[it[2]];
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
      return '<a class="back" href="#/search">Search</a>' +
        '<header class="entry-head"><span class="eyebrow">' + (it[4] ? 'Sealed product' : 'Single card') + '</span><h1>' + esc(shortName(it[1])) + '</h1>' +
        '<p class="where">' + esc([s[1], it[3] ? '#' + it[3] : '', it[5] || ''].filter(Boolean).join(', ')) + '</p></header>' +
        '<div class="entry-main">' + img(pick, 'card-img', true) +
        '<div class="entry-price"><span class="eyebrow">TCGplayer market price</span><div class="big' + (price.length > 7 ? ' long' : '') + '">' + price + '</div>' +
        '<p class="sub">' + (pr[2] != null ? 'Lowest listing ' + money(pr[2]) : 'Nothing listed right now') + '</p>' + chips + '</div></div>' +
        (rows.length ? '<section class="block"><div class="figs' + (rows.length === 2 ? ' two' : '') + '">' + rows.join('') + '</div></section>' : '') +
        chartBlock(series) +
        '<p class="note block">TCGplayer market price for the ' + esc(pr[0]) + ' printing, via <a href="https://tcgcsv.com/" rel="noopener">TCGCSV</a>, as of ' + niceDate(data.date) + '. eBay sold and graded prices are looked up only for cards in the weekly issue.</p>' +
        buyLinks(it[1], it[3], s[2], 'https://www.tcgplayer.com/product/' + it[0]);
    });
  }

  function issuesView(ctx) {
    var rows = ctx.index.map(function (e) {
      return '<a class="issue-row" href="#/issue/' + e.number + '/"><img src="' + esc(e.coverImage || PLACEHOLDER) + '" alt="" loading="lazy">' +
        '<span><b>Issue ' + pad(e.number, 2) + '</b><span>Week of ' + niceDate(e.date) + '. ' + e.picks + ' picks. Top pick: ' + esc(shortName(e.coverName || '')) + '</span></span></a>';
    }).join('');
    return '<header class="page-head"><h1>Back issues</h1></header><div class="page">' + rows +
      '<p style="margin-top:16px">A new issue is cut every Thursday night, ready for Friday morning. Once four weeks of issues exist, each back issue will show how its picks did.</p></div>';
  }

  function howView(ctx) {
    var issue = ctx.issue, days = span(issue);
    var rules = issue.categories.map(function (c) { return '<li><b>' + esc(c.title) + '.</b> ' + esc(c.rule) + '</li>'; }).join('');
    var sources = issue.sources.map(function (s) { return '<li><a href="' + esc(s.url) + '" rel="noopener">' + esc(s.name) + '</a>. ' + esc(s.note) + '</li>'; }).join('');
    return '<header class="page-head"><h1>How it works</h1></header><div class="page">' +
      '<p class="lede">Every day a job copies the TCGplayer market price of every English Pokémon single and sealed product, about ' + Number(issue.stats.productsScanned).toLocaleString('en-US') +
      ' products. Once a week it compares today with a week, 30 days and 90 days ago and runs the rules below. Nothing is hand-picked.</p>' +
      (days !== 7 ? '<p>This issue measures its short-term move over ' + days + ' days instead of 7, because the free price archive has a gap in late September 2026. From the next issue on it is a true 7-day move.</p>' : '') +
      '<h2>Where the numbers come from</h2><ul>' + sources + '</ul>' +
      '<h2>The rule for each list</h2><ul>' + rules + '</ul>' +
      '<h2>Checks on every pick</h2><ul>' +
      '<li>It must have a sales-based market price today and at least one copy listed for sale now.</li>' +
      '<li>It must actually trade. The job checks how often the market price changed across the readings on file. A price that never moves usually means no sales, and those cards are left out.</li>' +
      '<li>For rising picks, the lowest current listing must sit between 30% under and 25% over the market price, so the move is backed by what sellers are asking and you can buy near the quoted price.</li>' +
      '<li>A short-term move above 300% is treated as a data error and dropped.</li>' +
      '<li>At most three picks per set in a list, no card appears in two lists, and presale products are left out.</li></ul>' +
      '<h2>Scores and confidence</h2><p>The Heat score (1 to 99) blends the short-term and 30-day moves. Deal scores measure a discount, either to the 90-day median or, for sealed products without a history yet, to the market price. Steady scores measure how tight the price band is. Confidence is High when the card trades often, has a full price history and its listings match the market price.</p>' +
      '<h2>What this free version cannot see</h2><ul>' +
      '<li>Individual eBay sales. eBay sold figures are averages and counts for the cards in the issue, not a list of each sale. The "eBay sold listings" button on every card opens the live list on eBay.</li>' +
      '<li>Whole-catalog sales counts. Picks are screened on price movement; sale counts are shown for the picks themselves.</li>' +
      '<li>Sealed trends before October 2026. The history seed covers singles only, so the sealed list ranks by listing discount until a week of sealed prices exists.</li>' +
      '<li>Reddit and X chatter. Not connected yet.</li></ul>' +
      '<h2>The fine print</h2><p>This is market information, not financial advice. A price that rose last week can fall next week. Not affiliated with or endorsed by Nintendo, The Pokémon Company, TCGplayer or eBay. Card images are shown only to identify the cards being priced.</p></div>';
  }

  function notFound() { return '<p class="empty">That page is not in this issue. <a href="#/">Go to the front page</a>.</p>'; }

  // ---------- router ----------
  function setNav(name) {
    document.querySelectorAll('.nav a').forEach(function (a) {
      if (a.getAttribute('data-nav') === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  function show(html) {
    screen.innerHTML = html;
    wireChart(screen);
    window.scrollTo(0, 0);
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
      else { setNav('issue'); renderTabs(ctx, ''); html = frontView(ctx); }
      show(html);
      document.title = ctx.issue.title + ' weekly, issue ' + ctx.issue.number;
    }).catch(fail);
  }

  // Swipe left for the next section or pick, right for the previous one.
  var touch = null;
  screen.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1 || e.target.closest('.chart, input, .tabs')) { touch = null; return; }
    touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  screen.addEventListener('touchend', function (e) {
    if (!touch) return;
    var dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y, dt = Date.now() - touch.t;
    touch = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < 2.2 * Math.abs(dy) || dt > 700) return;
    var target = dx < 0 ? swipe.next : swipe.prev;
    if (target) location.hash = target;
  }, { passive: true });
  // Arrow keys do the same on a keyboard.
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
    var target = e.key === 'ArrowRight' ? swipe.next : (e.key === 'ArrowLeft' ? swipe.prev : null);
    if (target) location.hash = target;
  });

  window.addEventListener('hashchange', route);
  route();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
