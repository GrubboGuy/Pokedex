/* Pokédex weekly: renders the issue files written by the data job. No build step. */
(function () {
  'use strict';

  var screen = document.getElementById('screen');
  var cache = {};
  var indexPromise = null;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
  function niceDate(iso, withYear) {
    var p = iso.split('-');
    return MONTHS[+p[1] - 1] + ' ' + (+p[2]) + (withYear === false ? '' : ', ' + p[0]);
  }
  function span(issue) { return issue.shortSpanDays || 7; }
  function pad(n, len) { n = String(n); while (n.length < len) n = '0' + n; return n; }
  function bigImage(url) { return url ? url.replace('_200w.', '_in_1000x1000.') : ''; }
  // "Terapagos ex - 173/142" -> "Terapagos ex" for headlines; the number is shown beside the set.
  function shortName(name) { return String(name || '').replace(/\s+-\s+[A-Za-z0-9]+\/[A-Za-z0-9]+$/, ''); }

  var PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350"><rect width="250" height="350" rx="12" fill="#23232A"/>' +
    '<rect x="14" y="14" width="222" height="322" rx="8" fill="none" stroke="#3A3A44" stroke-width="3"/>' +
    '<circle cx="125" cy="175" r="46" fill="none" stroke="#5A5C66" stroke-width="7"/>' +
    '<path d="M79 175h92" stroke="#5A5C66" stroke-width="7"/><circle cx="125" cy="175" r="15" fill="#23232A" stroke="#5A5C66" stroke-width="7"/></svg>');

  function img(pick, cls, big) {
    var small = pick.image || PLACEHOLDER;
    var src = big && pick.image ? bigImage(pick.image) : small;
    var kind = pick.kind === 'sealed' ? ' sealed' : '';
    return '<img class="' + (cls || 'card-img') + kind + '" src="' + esc(src) + '" data-small="' + esc(small) +
      '" alt="' + esc(pick.name) + '" loading="lazy" decoding="async">';
  }
  // Fall back from the large image to the small one, then to a drawn placeholder.
  document.addEventListener('error', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'IMG') return;
    var small = el.getAttribute('data-small');
    if (small && el.src !== small && !el.dataset.triedSmall) { el.dataset.triedSmall = '1'; el.src = small; return; }
    if (el.src !== PLACEHOLDER) { el.src = PLACEHOLDER; el.classList.add('missing'); }
  }, true);

  function seal(pick, small) {
    return '<span class="seal' + (small ? ' sm' : '') + '" title="' + esc(pick.scoreLabel) + ' score ' + pick.score + ' out of 99"><span><b>' +
      pick.score + '</b><small>' + esc(pick.scoreLabel) + '</small></span></span>';
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
  function runhead(ctx, label, href) {
    return '<div class="runhead"><a href="' + base(ctx) + '/">Issue ' + pad(ctx.issue.number, 2) + '</a><span class="sep"></span>' +
      (href ? '<a href="' + href + '">' + esc(label) + '</a>' : '<span>' + esc(label) + '</span>') +
      '<span class="folio">' + niceDate(ctx.issue.date, false) + '</span></div>';
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
  function base(ctx) { return ctx.issue.number === ctx.latest ? '#' : '#/issue/' + ctx.issue.number; }

  // ---------- views ----------
  function coverView(ctx) {
    var issue = ctx.issue, b = base(ctx), days = span(issue);
    var coverCat = null, coverPick = null;
    issue.categories.forEach(function (c) {
      c.picks.forEach(function (p) {
        if (issue.cover && c.id === issue.cover.category && p.key === issue.cover.key) { coverCat = c; coverPick = p; }
      });
    });
    if (!coverPick) { coverCat = issue.categories[0]; coverPick = coverCat.picks[0]; }
    var coverHref = b + '/card/' + coverCat.id + '/' + coverPick.rank;

    var lines = issue.categories.filter(function (c) { return c !== coverCat; }).slice(0, 3).map(function (c) {
      var p = c.picks[0];
      return '<a class="cover-line" href="' + b + '/list/' + c.id + '"><span class="cl-kicker">' + esc(c.short || c.title) + '</span>' +
        '<span class="cl-name' + (/\S{11,}/.test(shortName(p.name)) ? ' tight' : '') + '">' + esc(shortName(p.name)) + '</span><span class="cl-move">' + pct(p.ch7) + ' in ' + days + ' days</span></a>';
    }).join('');

    var page = 0;
    var toc = issue.categories.map(function (c) {
      var first = page + 1;
      page += c.picks.length;
      var fan = c.picks.slice(0, 2).map(function (p) { return img(p, 'thumb'); }).join('');
      return '<li class="tone-' + c.color + '"><a href="' + b + '/list/' + c.id + '"><span class="pg">' + pad(first, 2) + '</span>' +
        '<span><h3>' + esc(listTitle(c)) + '</h3><p>' + esc(c.blurb) + '. <b>' + esc(shortName(c.picks[0].name)) + '</b> leads ' + c.picks.length + ' picks.</p></span>' +
        '<span class="fan">' + fan + '</span></a></li>';
    }).join('');

    var s = issue.stats;
    return '<section class="cover">' +
      '<div class="cover-date"><span><b>Issue ' + pad(issue.number, 2) + '</b></span><span>Week of ' + niceDate(issue.date) + '</span></div>' +
      '<h1 class="masthead">' + esc(issue.title) + '</h1>' +
      '<p class="tagline"><span>' + esc(issue.tagline) + '</span><span>' + page + ' picks inside</span></p>' +
      '<div class="cover-body"><div class="cover-lines">' + lines + '</div>' +
        '<a class="cover-art" href="' + coverHref + '" aria-label="Open ' + esc(coverPick.name) + '">' + img(coverPick, 'card-img', true) + seal(coverPick) + '</a></div>' +
      '<a class="cover-feature" href="' + coverHref + '"><span class="cl-kicker">On the cover</span>' +
        '<span class="cf-name">' + esc(shortName(coverPick.name)) + '</span>' +
        '<span class="cf-deck">' + esc(where(coverPick)) + '. <b>' + pct(coverPick.ch7) + ' in ' + days + ' days</b>, now ' + money(coverPick.price) + '.</span></a>' +
      '<div class="cover-foot"><span class="barcode"><i></i>' + pad(issue.number, 3) + ' ' + issue.date.replace(/-/g, '') + '</span>' +
        '<span class="cover-note">Every price is real TCGplayer data, pulled ' + niceDate(issue.date) + '.</span></div>' +
      '</section>' +
      '<div class="section-head"><h2>In this issue</h2></div>' +
      '<ol class="toc">' + toc + '</ol>' +
      '<div class="lcd"><div class="lcd-big">SCAN COMPLETE</div>' +
        Number(s.productsScanned).toLocaleString('en-US') + ' products checked<br>' +
        Number(s.printingsScored).toLocaleString('en-US') + ' printings scored<br>' +
        s.snapshots + ' price snapshots since ' + niceDate(s.historyFrom, false) + '</div>' +
      '<p class="fine">Prices are TCGplayer market prices via TCGCSV. This is market information, not financial advice, and past moves do not predict future prices. ' +
        '<a href="#/how">How the picks are made</a>. Not affiliated with or endorsed by Nintendo, The Pokémon Company, TCGplayer or eBay.</p>';
  }

  function listView(ctx, id) {
    var issue = ctx.issue, b = base(ctx), days = span(issue);
    var cat = issue.categories.filter(function (c) { return c.id === id; })[0];
    if (!cat) return notFound();
    var lead = cat.picks[0];
    var rest = cat.picks.slice(1).map(function (p) {
      return '<a class="pick" href="' + b + '/card/' + cat.id + '/' + p.rank + '">' +
        '<div class="pick-art"><span class="rank">' + p.rank + '</span>' + img(p) + seal(p, true) + '</div>' +
        '<div class="pick-info"><h3>' + esc(shortName(p.name)) + '</h3><p class="where">' + esc(where(p)) + '</p>' +
        '<div class="nums"><span class="price">' + money(p.price) + '</span>' + move(p.ch7) + '</div></div></a>';
    }).join('');
    return '<div class="tone-' + cat.color + '">' + runhead(ctx, cat.short || cat.title) +
      '<header class="opener"><h1>' + esc(listTitle(cat)) + '</h1><p>' + esc(cat.blurb) + '</p></header>' +
      '<a class="lead" href="' + b + '/card/' + cat.id + '/' + lead.rank + '">' +
        '<div class="lead-art"><span class="rank">1</span>' + img(lead, 'card-img', true) + '</div>' +
        '<div><h2>' + esc(shortName(lead.name)) + '</h2><p class="where">' + esc(where(lead)) + '</p>' +
        '<div class="price">' + money(lead.price) + '</div>' +
        '<div class="nums">' + seal(lead, true) + move(lead.ch7) + '</div></div>' +
        '<p class="why">' + esc(lead.reason) + '</p></a>' +
      '<div class="picks">' + rest + '</div>' +
      '<p class="aside"><b>How this list is picked</b>' + esc(cat.rule) + ' ' + cat.eligible + ' passed this week; these are the top ' + cat.picks.length + '.</p>' +
      '<p class="fine" style="padding-top:14px">Change shown is the ' + days + '-day move in TCGplayer market price, as of ' + niceDate(issue.date) + '.</p></div>';
  }

  function chart(series) {
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
      return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="#E4E5EA" stroke-width="1"/>' +
        '<text x="' + (W - R + 7) + '" y="' + (+y + 4) + '" font-size="11" fill="#5A5C66">' + money(v, true).replace(/\.\d\d$/, v >= 100 ? '' : '$&') + '</text>';
    }).join('');
    var last = series[series.length - 1];
    return '<div class="chart" data-series="' + esc(JSON.stringify(series)) + '">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Price from ' + niceDate(series[0][0]) + ' to ' + niceDate(last[0]) + '">' + grid +
      '<polygon points="' + L + ',' + (H - B) + ' ' + pts.join(' ') + ' ' + X(last[0]).toFixed(1) + ',' + (H - B) + '" fill="#1B45B4" opacity=".09"/>' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#1B45B4" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + X(last[0]).toFixed(1) + '" cy="' + Y(last[1]).toFixed(1) + '" r="4" fill="#1B45B4" stroke="#fff" stroke-width="2"/>' +
      '<line class="cross" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" stroke="#111114" stroke-width="1" visibility="hidden"/>' +
      '<circle class="dot" r="4.5" fill="#fff" stroke="#111114" stroke-width="2" visibility="hidden"/>' +
      '<text x="' + L + '" y="' + (H - 6) + '" font-size="11" fill="#5A5C66">' + niceDate(series[0][0], false) + '</text>' +
      '<text x="' + (W - R) + '" y="' + (H - 6) + '" font-size="11" fill="#5A5C66" text-anchor="end">' + niceDate(last[0], false) + '</text>' +
      '</svg><span class="tip" hidden></span></div>';
  }
  function wireChart(root) {
    var el = root.querySelector('.chart');
    if (!el) return;
    var series = JSON.parse(el.getAttribute('data-series'));
    var svg = el.querySelector('svg'), cross = el.querySelector('.cross'), dot = el.querySelector('.dot'), tip = el.querySelector('.tip');
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

  function breakdown(p, days) {
    function row(label, value, share, neg) {
      return '<div class="rowb"><dt>' + label + '</dt><dd>' + value + '</dd><span class="bar"><i' + (neg ? ' class="neg"' : '') +
        ' style="width:' + Math.round(Math.max(0.04, Math.min(1, share)) * 100) + '%"></i></span></div>';
    }
    var rows = [row(days + ' days', pct(p.ch7), Math.abs(p.ch7) / 0.3, p.ch7 < 0)];
    if (p.ch30 != null) rows.push(row('30 days', pct(p.ch30), Math.abs(p.ch30) / 0.5, p.ch30 < 0));
    if (p.ch90 != null) rows.push(row('90 days', pct(p.ch90), Math.abs(p.ch90) / 1, p.ch90 < 0));
    var gap = p.low / p.price - 1, g = Math.round(Math.abs(gap) * 100);
    rows.push(row('Cheapest listing', g === 0 ? 'At market' : g + '% ' + (gap < 0 ? 'under' : 'over'), 1 - Math.min(1, Math.abs(gap) / 0.3), false));
    if (p.activity != null) rows.push(row('Trading', p.activity >= 0.6 ? 'Busy' : (p.activity >= 0.34 ? 'Regular' : 'Light'), p.activity, false));
    return rows.join('');
  }

  function cardView(ctx, listId, rank) {
    var issue = ctx.issue, b = base(ctx), days = span(issue);
    var cat = issue.categories.filter(function (c) { return c.id === listId; })[0];
    var p = cat && cat.picks.filter(function (x) { return String(x.rank) === String(rank); })[0];
    if (!p) return notFound();
    var entryNo = 0, total = 0;
    issue.categories.forEach(function (c) { c.picks.forEach(function (x) { total++; if (x === p) entryNo = total; }); });

    var graded = '';
    if (p.graded) {
      var slabs = [['psa10', 'PSA 10'], ['psa9', 'PSA 9'], ['psa8', 'PSA 8']].filter(function (g) { return p.graded[g[0]]; }).map(function (g) {
        var d = p.graded[g[0]];
        return '<div class="slab"><small>' + g[1] + '</small><b>' + money(d.price, true) + '</b>' +
          (d.confidence ? '<span>' + esc(d.confidence) + ' confidence</span>' : '') + '</div>';
      }).join('');
      if (slabs) graded = '<section class="block"><h2>Slab report</h2><div class="graded">' + slabs + '</div></section>';
    }
    var rows = p.series.slice().reverse().map(function (s) { return '<tr><td>' + niceDate(s[0]) + '</td><td>' + money(s[1]) + '</td></tr>'; }).join('');
    var ebay = 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent([shortName(p.name), p.number ? p.number.split('/')[0] : '', p.setAbbr || ''].join(' ').trim()) + '&LH_Sold=1&LH_Complete=1';
    var prev = cat.picks[p.rank - 2], next = cat.picks[p.rank];
    var confText = { High: 'a price that moves often, a full history and listings that match the market price', Medium: 'a partial history or listings a little off the market price', Low: 'a thin history or listings far from the market price' }[p.confidence];
    var price = money(p.price);

    return '<div class="tone-' + cat.color + '">' + runhead(ctx, cat.short || cat.title, b + '/list/' + cat.id) +
      '<header class="entry-head"><h1>' + esc(shortName(p.name)) + '</h1><p>' + esc(where(p)) + (p.rarity ? '. ' + esc(p.rarity) : '') + '</p></header>' +
      '<div class="lcd entry-lcd"><div class="row"><span>No. ' + pad(entryNo, 3) + '</span><span>PICK ' + p.rank + ' OF ' + cat.picks.length + '</span></div></div>' +
      '<div class="entry-main"><div class="scanner">' + img(p, 'card-img', true) + '<span class="scanline"></span></div>' +
      '<div class="entry-price"><span class="label">TCGplayer market price</span><div class="big' + (price.length > 7 ? ' long' : '') + '">' + price + '</div>' +
      '<p class="low">Lowest listing ' + money(p.low) + '</p>' +
      '<span class="chip ' + p.confidence.toLowerCase() + '">' + esc(p.confidence) + ' confidence</span></div></div>' +
      '<section class="review"><div class="score"><b>' + p.score + '</b><small>' + esc(p.scoreLabel) + '</small><em>' + verdict(p) + '</em></div>' +
      '<dl>' + breakdown(p, days) + '</dl></section>' +
      '<section class="bottomline"><h2>Why it made the issue</h2><p>' + esc(p.reason) + '</p></section>' +
      graded +
      '<section class="block"><h2>Market price, ' + niceDate(p.series[0][0], false) + ' to ' + niceDate(p.series[p.series.length - 1][0], false) + '</h2>' + chart(p.series) +
      '<details class="points"><summary>Show all ' + p.series.length + ' price readings</summary><table>' + rows + '</table></details></section>' +
      '<p class="source">Raw price: TCGplayer market price for the ' + esc(p.printing) + ' printing, via <a href="https://tcgcsv.com/" rel="noopener">TCGCSV</a>, pulled ' + niceDate(issue.date) + '. ' +
      (p.graded ? 'Graded prices: completed eBay sales via <a href="https://www.pokemonpricetracker.com/" rel="noopener">PokemonPriceTracker</a>, pulled ' + niceDate(p.graded.date) + '. They are for the card and may mix printings, so check the slab matches this one. ' : '') +
      esc(p.confidence) + ' confidence means ' + confText + '. Not financial advice.</p>' +
      '<div class="buy"><a href="' + esc(p.url) + '" target="_blank" rel="noopener">Check it on TCGplayer</a><a class="alt" href="' + esc(ebay) + '" target="_blank" rel="noopener">eBay sold listings</a></div>' +
      '<div class="pager">' + (prev ? '<a href="' + b + '/card/' + cat.id + '/' + prev.rank + '">Previous pick</a>' : '<a href="' + b + '/list/' + cat.id + '">Back to the list</a>') +
      (next ? '<a href="' + b + '/card/' + cat.id + '/' + next.rank + '">Next pick</a>' : '<a href="' + b + '/list/' + cat.id + '">Back to the list</a>') + '</div></div>';
  }

  function issuesView(ctx) {
    var rows = ctx.index.map(function (e) {
      return '<a class="issue-row" href="#/issue/' + e.number + '/"><img src="' + esc(e.coverImage || PLACEHOLDER) + '" alt="" loading="lazy">' +
        '<span><b>Issue ' + pad(e.number, 2) + '</b><span>Week of ' + niceDate(e.date) + '. ' + e.picks + ' picks. Cover: ' + esc(shortName(e.coverName || '')) + '</span></span></a>';
    }).join('');
    return '<div class="section-head"><h1>Back issues</h1></div><div class="page">' + rows +
      '<p style="margin-top:16px">A new issue is cut every Thursday night, ready for Friday morning. Once four weeks of issues exist, each back issue will show how its picks did.</p></div>';
  }

  function howView(ctx) {
    var issue = ctx.issue, days = span(issue);
    var rules = issue.categories.map(function (c) { return '<li><b>' + esc(c.title) + '.</b> ' + esc(c.rule) + '</li>'; }).join('');
    var sources = issue.sources.map(function (s) { return '<li><a href="' + esc(s.url) + '" rel="noopener">' + esc(s.name) + '</a>. ' + esc(s.note) + '</li>'; }).join('');
    return '<div class="section-head"><h1>How it works</h1></div><div class="page">' +
      '<p class="lede">Every day a job copies the TCGplayer market price of every English Pokémon single and sealed product, about ' + Number(issue.stats.productsScanned).toLocaleString('en-US') +
      ' products. Once a week it compares today with a week, 30 days and 90 days ago and runs the rules below. Nothing is hand-picked.</p>' +
      (days !== 7 ? '<p>This issue measures its short-term move over ' + days + ' days instead of 7, because the free price archive has a gap in late September 2026. From the next issue on it is a true 7-day move.</p>' : '') +
      '<h2>Where the numbers come from</h2><ul>' + sources + '</ul>' +
      '<h2>The rules for each list</h2><ul>' + rules + '</ul>' +
      '<h2>Checks on every pick</h2><ul>' +
      '<li>It must have a sales-based market price today and at the start of the period, and at least one copy listed for sale now.</li>' +
      '<li>It must actually trade. The free feed has no sales counts, so the job checks how often the market price changed across the readings on file. A price that never moves usually means no sales, and those cards are left out.</li>' +
      '<li>For rising picks, the lowest current listing must sit between 30% under and 25% over the market price, so the move is backed by what sellers are asking and you can buy near the quoted price.</li>' +
      '<li>A short-term move above 300% is treated as a data error and dropped.</li>' +
      '<li>At most three picks per set in a list, no card appears in two lists, and presale products are left out.</li></ul>' +
      '<h2>Scores and confidence</h2><p>The Heat score (1 to 99) blends the short-term and 30-day moves. Deal scores measure the discount to the 90-day median, and Steady scores measure how tight the price band is. Confidence is High when the card trades often, has a full price history and its listings match the market price, and Low when either the history or the listings are thin.</p>' +
      '<h2>What this free version cannot see</h2><ul>' +
      '<li>How many copies sold. TCGplayer\'s market price is built from sales, but the free feed has no sales counts, so a thinly traded card can move on a few sales.</li>' +
      '<li>Prices by condition. The free feed has one market price per printing, and the lowest listing can be a played or damaged copy. This matters most for vintage cards.</li>' +
      '<li>Graded prices for the whole catalog. PSA prices are looked up only for the cards in the issue.</li>' +
      '<li>Sealed product trends before October 2026. The history seed covers singles only, so sealed lists start once a week of live prices exists.</li>' +
      '<li>Reddit and X chatter. Not connected yet.</li></ul>' +
      '<h2>The fine print</h2><p>This is market information, not financial advice. A price that rose last week can fall next week. Not affiliated with or endorsed by Nintendo, The Pokémon Company, TCGplayer or eBay. Card images are shown only to identify the cards being priced.</p></div>';
  }

  // Shrink a headline until it fits its line, whatever font actually loaded.
  function fit(selector, floor) {
    var el = screen.querySelector(selector);
    if (!el) return;
    el.style.fontSize = '';
    var size = parseFloat(getComputedStyle(el).fontSize), guard = 0;
    while (el.scrollWidth > el.clientWidth + 1 && size > floor && guard++ < 80) { size -= 2; el.style.fontSize = size + 'px'; }
  }
  function fitAll() { fit('.masthead', 40); }
  window.addEventListener('resize', fitAll);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAll);

  function notFound() { return '<p class="empty">That page is not in this issue. <a href="#/">Go to the cover</a>.</p>'; }

  // ---------- router ----------
  function route() {
    var parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    var number = null;
    if (parts[0] === 'issue') { number = parseInt(parts[1], 10) || null; parts = parts.slice(2); }
    var view = parts[0] || 'cover';
    document.querySelectorAll('.dex-pad a').forEach(function (a) {
      var on = a.getAttribute('data-nav') === (view === 'list' || view === 'card' ? 'cover' : view);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    getIssue(number).then(function (ctx) {
      var html;
      if (view === 'list') html = listView(ctx, parts[1]);
      else if (view === 'card') html = cardView(ctx, parts[1], parts[2]);
      else if (view === 'issues') html = issuesView(ctx);
      else if (view === 'how') html = howView(ctx);
      else html = coverView(ctx);
      screen.innerHTML = html;
      wireChart(screen);
      fitAll();
      document.title = ctx.issue.title + ', issue ' + ctx.issue.number;
      window.scrollTo(0, 0);
    }).catch(function (err) {
      screen.innerHTML = err && err.message === 'empty'
        ? '<p class="empty">The first issue has not been built yet. It appears here after the data job runs.</p>'
        : '<p class="empty">Could not load the issue. Check your connection and reload.</p>';
    });
  }

  window.addEventListener('hashchange', route);
  route();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
