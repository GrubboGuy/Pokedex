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
  function money(n) {
    if (n == null) return '';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pct(x) {
    if (x == null) return 'n/a';
    var v = Math.round(x * 100);
    return (v > 0 ? '+' : '') + v + '%';
  }
  function moveClass(x) { return x == null || Math.round(x * 100) === 0 ? 'flat' : (x > 0 ? 'up' : 'down'); }
  function arrow(x) { return x == null || Math.round(x * 100) === 0 ? '' : (x > 0 ? '▲ ' : '▼ '); }
  function move(x) { return '<span class="move ' + moveClass(x) + '">' + arrow(x) + pct(x) + '</span>'; }
  function niceDate(iso, withYear) {
    var p = iso.split('-');
    return MONTHS[+p[1] - 1] + ' ' + (+p[2]) + (withYear === false ? '' : ', ' + p[0]);
  }
  function span(issue) { return issue.shortSpanDays || 7; }
  function pad(n, len) { n = String(n); while (n.length < len) n = '0' + n; return n; }
  function bigImage(url) { return url ? url.replace('_200w.', '_in_1000x1000.') : ''; }
  var PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350"><rect width="250" height="350" fill="#1B1B22"/>' +
    '<circle cx="125" cy="175" r="62" fill="none" stroke="#fff" stroke-width="10"/>' +
    '<path d="M63 175h124" stroke="#fff" stroke-width="10"/><circle cx="125" cy="175" r="20" fill="#1B1B22" stroke="#fff" stroke-width="10"/></svg>');

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

  function burst(pick, small) {
    return '<span class="burst' + (small ? ' sm' : '') + '" title="' + esc(pick.scoreLabel) + ' score ' + pick.score + ' out of 99"><span><b>' +
      pick.score + '</b><small>' + esc(pick.scoreLabel) + '</small></span></span>';
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
  function base(ctx) { return ctx.issue.number === ctx.latest ? '#' : '#/issue/' + ctx.issue.number; }

  // ---------- views ----------
  function coverView(ctx) {
    var issue = ctx.issue, b = base(ctx);
    var coverCat = null, coverPick = null;
    issue.categories.forEach(function (c) {
      c.picks.forEach(function (p) {
        if (issue.cover && c.id === issue.cover.category && p.key === issue.cover.key) { coverCat = c; coverPick = p; }
      });
    });
    if (!coverPick) { coverCat = issue.categories[0]; coverPick = coverCat.picks[0]; }

    var lines = issue.categories.filter(function (c) { return c !== coverCat; }).slice(0, 3).map(function (c) {
      var p = c.picks[0];
      return '<a class="cover-line" href="' + b + '/list/' + c.id + '"><span class="cl-kicker">' + esc(c.short || c.title) + '</span>' +
        '<span class="cl-name">' + esc(p.name) + '</span><span class="cl-move">' + arrow(p.ch7) + pct(p.ch7) + ' in ' + span(issue) + ' days</span></a>';
    }).join('');

    var tiles = issue.categories.map(function (c) {
      var fan = c.picks.slice(0, 3).map(function (p) { return img(p, 'fan'); }).join('');
      return '<a class="tile tone-' + c.color + '" href="' + b + '/list/' + c.id + '">' +
        '<div class="tile-band"><h3>' + esc(listTitle(c)) + '</h3></div>' +
        '<div class="tile-fan">' + fan + '</div>' +
        '<div class="tile-foot"><b>' + esc(c.picks[0].name) + '</b>leads ' + c.picks.length + ' picks</div></a>';
    }).join('');

    var s = issue.stats;
    return '<section class="cover">' +
      '<div class="cover-meta"><b>Issue ' + pad(issue.number, 2) + '</b><span>Week of ' + niceDate(issue.date) + '</span></div>' +
      '<h1 class="masthead">' + esc(issue.title) + '</h1>' +
      '<p class="tagline">' + esc(issue.tagline) + '</p>' +
      '<div class="cover-body"><div class="cover-lines">' +
        '<a class="cover-line" href="' + b + '/card/' + coverCat.id + '/' + coverPick.rank + '"><span class="cl-kicker">Cover card</span>' +
        '<span class="cl-name">' + esc(coverPick.name) + '</span><span class="cl-move">' + arrow(coverPick.ch7) + pct(coverPick.ch7) + ' in ' + span(issue) + ' days, now ' + money(coverPick.price) + '</span></a>' +
        lines + '</div>' +
        '<a class="cover-art" href="' + b + '/card/' + coverCat.id + '/' + coverPick.rank + '" aria-label="Open ' + esc(coverPick.name) + '">' +
        img(coverPick, 'card-img', true) + burst(coverPick) + '</a></div>' +
      '<div class="cover-foot"><span class="barcode"><i></i>' + pad(issue.number, 3) + ' ' + issue.date.replace(/-/g, '') + '</span>' +
        '<span class="cover-note">Every price is real TCGplayer data, pulled ' + niceDate(issue.date) + '.</span></div>' +
      '</section>' +
      '<h2 class="section-head">In this issue</h2>' +
      '<div class="contents">' + tiles + '</div>' +
      '<div class="lcd"><div class="lcd-big">SCAN COMPLETE</div>' +
        Number(s.productsScanned).toLocaleString('en-US') + ' products checked<br>' +
        Number(s.printingsScored).toLocaleString('en-US') + ' printings scored<br>' +
        s.snapshots + ' price snapshots since ' + niceDate(s.historyFrom, false) + '</div>' +
      '<p class="fine">Prices are TCGplayer market prices via TCGCSV. This is market information, not financial advice, and past moves do not predict future prices. ' +
        '<a href="#/how">How the picks are made</a>. Not affiliated with or endorsed by Nintendo, The Pokémon Company, TCGplayer or eBay.</p>';
  }

  function listView(ctx, id) {
    var issue = ctx.issue, b = base(ctx);
    var cat = issue.categories.filter(function (c) { return c.id === id; })[0];
    if (!cat) return notFound();
    var picks = cat.picks.map(function (p) {
      return '<a class="pick" href="' + b + '/card/' + cat.id + '/' + p.rank + '">' +
        '<div class="pick-art"><span class="rank">' + p.rank + '</span>' + burst(p, true) + img(p) + '</div>' +
        '<div class="pick-info"><h3>' + esc(p.name) + '</h3><p class="where">' + esc(where(p)) + '</p>' +
        '<div class="nums"><span class="price-tag">' + money(p.price) + '</span>' + move(p.ch7) + '</div></div></a>';
    }).join('');
    return '<header class="list-head tone-' + cat.color + '"><a class="crumb" href="' + b + '/">Issue ' + pad(issue.number, 2) + '</a>' +
      '<h1>' + esc(listTitle(cat)) + '</h1><p>' + esc(cat.blurb) + '</p></header>' +
      '<div class="rule-box"><b>How this list is picked</b><br>' + esc(cat.rule) + ' ' + cat.eligible + ' passed this week; these are the top ' + cat.picks.length + '.</div>' +
      '<div class="picks">' + picks + '</div>' +
      '<p class="fine">Change shown is the ' + span(issue) + '-day move in TCGplayer market price, as of ' + niceDate(issue.date) + '.</p>';
  }

  function chart(series) {
    var W = 340, H = 170, L = 6, R = 48, T = 14, B = 24;
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
      return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="#E3E3E8" stroke-width="1"/>' +
        '<text x="' + (W - R + 6) + '" y="' + (+y + 4) + '" font-size="11" fill="#4A4A55">' + money(v).replace(/\.\d\d$/, v >= 100 ? '' : '$&') + '</text>';
    }).join('');
    var last = series[series.length - 1];
    return '<div class="chart" data-series="' + esc(JSON.stringify(series)) + '">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Price from ' + niceDate(series[0][0]) + ' to ' + niceDate(last[0]) + '">' + grid +
      '<polygon points="' + L + ',' + (H - B) + ' ' + pts.join(' ') + ' ' + X(last[0]).toFixed(1) + ',' + (H - B) + '" fill="#1746D1" opacity=".1"/>' +
      '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#1746D1" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + X(last[0]).toFixed(1) + '" cy="' + Y(last[1]).toFixed(1) + '" r="4" fill="#1746D1" stroke="#fff" stroke-width="2"/>' +
      '<line class="cross" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" stroke="#000" stroke-width="1" visibility="hidden"/>' +
      '<circle class="dot" r="4.5" fill="#fff" stroke="#000" stroke-width="2" visibility="hidden"/>' +
      '<text x="' + L + '" y="' + (H - 6) + '" font-size="11" fill="#4A4A55">' + niceDate(series[0][0], false) + '</text>' +
      '<text x="' + (W - R) + '" y="' + (H - 6) + '" font-size="11" fill="#4A4A55" text-anchor="end">' + niceDate(last[0], false) + '</text>' +
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
      tip.style.left = Math.max(46, Math.min(box.width - 46, px)) + 'px';
    }
    function hide() { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; }
    el.addEventListener('pointermove', show);
    el.addEventListener('pointerdown', show);
    el.addEventListener('pointerleave', hide);
  }

  function cardView(ctx, listId, rank) {
    var issue = ctx.issue, b = base(ctx);
    var cat = issue.categories.filter(function (c) { return c.id === listId; })[0];
    var p = cat && cat.picks.filter(function (x) { return String(x.rank) === String(rank); })[0];
    if (!p) return notFound();
    var entryNo = 0, total = 0;
    issue.categories.forEach(function (c) { c.picks.forEach(function (x) { total++; if (x === p) entryNo = total; }); });

    var graded = '';
    if (p.graded) {
      var slabs = [['psa10', 'PSA 10'], ['psa9', 'PSA 9'], ['psa8', 'PSA 8']].filter(function (g) { return p.graded[g[0]]; }).map(function (g) {
        var d = p.graded[g[0]];
        return '<div class="slab"><small>' + g[1] + (d.confidence ? ', ' + esc(d.confidence) + ' confidence' : '') + '</small><b>' + money(d.price) + '</b></div>';
      }).join('');
      if (slabs) graded = '<div class="graded">' + slabs + '</div>';
    }
    var rows = p.series.slice().reverse().map(function (s) { return '<tr><td>' + niceDate(s[0]) + '</td><td>' + money(s[1]) + '</td></tr>'; }).join('');
    var ebay = 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent([p.name, p.number ? p.number.split('/')[0] : '', p.setAbbr || ''].join(' ').trim()) + '&LH_Sold=1&LH_Complete=1';
    var prev = cat.picks[p.rank - 2], next = cat.picks[p.rank];
    var confText = { High: 'a price that moves often, a full history and listings that match the market price', Medium: 'a partial history or listings a little off the market price', Low: 'a thin history or listings far from the market price' }[p.confidence];

    return '<div class="lcd entry-lcd"><div class="row"><span>No. ' + pad(entryNo, 3) + '</span><span>PICK ' + p.rank + ' OF ' + cat.picks.length + '</span></div>' +
      '<div>' + esc((cat.short || cat.title).toUpperCase()) + '</div>' +
      '<div class="lcd-big">' + esc(p.name.toUpperCase()) + '</div>' + esc(where(p)) + (p.rarity ? '<br>' + esc(p.rarity) : '') + '</div>' +
      '<div class="entry-main"><div class="scanner">' + img(p, 'card-img', true) + '<span class="scanline"></span></div>' +
      '<div class="entry-price"><div class="label">TCGplayer market price</div><div class="big">' + money(p.price) + '</div>' +
      '<div class="low">Lowest listing ' + money(p.low) + '</div>' +
      '<div class="burst-row">' + burst(p) + '<span class="chip ' + p.confidence.toLowerCase() + '">' + esc(p.confidence) + ' confidence</span></div></div></div>' +
      '<div class="stats"><div><small>' + span(issue) + ' days</small>' + move(p.ch7) + '</div><div><small>30 days</small>' + move(p.ch30) + '</div><div><small>90 days</small>' + move(p.ch90) + '</div></div>' +
      graded +
      '<div class="why"><h2>Why it made the issue</h2><p>' + esc(p.reason) + '</p></div>' +
      '<div class="chart-wrap"><h2>Market price, last ' + p.series.length + ' readings</h2>' + chart(p.series) +
      '<details class="points"><summary>Show every price reading</summary><table>' + rows + '</table></details></div>' +
      '<p class="source">Raw price: TCGplayer market price for the ' + esc(p.printing) + ' printing, via <a href="https://tcgcsv.com/" rel="noopener">TCGCSV</a>, pulled ' + niceDate(issue.date) + '. ' +
      (p.graded ? 'Graded prices: completed eBay sales via <a href="https://www.pokemonpricetracker.com/" rel="noopener">PokemonPriceTracker</a>, pulled ' + niceDate(p.graded.date) + '. ' : '') +
      esc(p.confidence) + ' confidence means ' + confText + '. Not financial advice.</p>' +
      '<div class="buy"><a href="' + esc(p.url) + '" target="_blank" rel="noopener">Check it on TCGplayer</a><a class="alt" href="' + esc(ebay) + '" target="_blank" rel="noopener">eBay sold listings</a></div>' +
      '<div class="pager">' + (prev ? '<a href="' + b + '/card/' + cat.id + '/' + prev.rank + '">Previous pick</a>' : '<a href="' + b + '/list/' + cat.id + '">Back to the list</a>') +
      (next ? '<a href="' + b + '/card/' + cat.id + '/' + next.rank + '">Next pick</a>' : '<a href="' + b + '/list/' + cat.id + '">Back to the list</a>') + '</div>';
  }

  function issuesView(ctx) {
    var rows = ctx.index.map(function (e) {
      return '<a class="issue-row" href="#/issue/' + e.number + '/"><img src="' + esc(e.coverImage || PLACEHOLDER) + '" alt="" loading="lazy">' +
        '<span><b>Issue ' + pad(e.number, 2) + '</b><span>Week of ' + niceDate(e.date) + ', ' + e.picks + ' picks, cover: ' + esc(e.coverName || '') + '</span></span></a>';
    }).join('');
    return '<h1 class="section-head">Back issues</h1><div class="page">' + rows +
      '<p style="margin-top:14px">A new issue is cut every Thursday night, ready for Friday morning. Once four weeks of issues exist, each back issue will show how its picks did.</p></div>';
  }

  function howView(ctx) {
    var issue = ctx.issue;
    var rules = issue.categories.map(function (c) { return '<li><b>' + esc(c.title) + '.</b> ' + esc(c.rule) + '</li>'; }).join('');
    var sources = issue.sources.map(function (s) { return '<li><a href="' + esc(s.url) + '" rel="noopener">' + esc(s.name) + '</a>. ' + esc(s.note) + '</li>'; }).join('');
    return '<h1 class="section-head">How it works</h1><div class="page">' +
      '<p>Every day a job copies the TCGplayer market price of every English Pokémon single and sealed product, about ' + Number(issue.stats.productsScanned).toLocaleString('en-US') +
      ' products. Once a week it compares today with a week, 30 days and 90 days ago and runs the rules below. Nothing is hand-picked.</p>' +
      (span(issue) !== 7 ? '<p>This issue measures its short-term move over ' + span(issue) + ' days instead of 7, because the free price archive has a gap in late September 2026. From the next issue on it is a true 7-day move.</p>' : '') +
      '<h2>Where the numbers come from</h2><ul>' + sources + '</ul>' +
      '<h2>The rules for each list</h2><ul>' + rules + '</ul>' +
      '<h2>Checks on every pick</h2><ul>' +
      '<li>It must have a sales-based market price today and a week ago, and at least one copy listed for sale now.</li>' +
      '<li>It must actually trade. The free feed has no sales counts, so the job checks how often the market price changed across the readings on file. A price that never moves usually means no sales, and those cards are left out.</li>' +
      '<li>For rising picks, the lowest current listing must sit between 30% under and 25% over the market price, so the move is backed by what sellers are asking and you can buy near the quoted price.</li>' +
      '<li>A weekly move above 300% is treated as a data error and dropped.</li>' +
      '<li>At most three picks per set in a list, no card appears in two lists, and presale products are left out.</li></ul>' +
      '<h2>Scores and confidence</h2><p>The Heat score (1 to 99) blends the short-term and 30-day moves. Deal scores measure the discount to the 90-day median, and Steady scores measure how tight the price band is. Confidence is High when the card trades often, has a full price history and its listings match the market price, and Low when either the history or the listings are thin.</p>' +
      '<h2>What this free version cannot see</h2><ul>' +
      '<li>How many copies sold. TCGplayer\'s market price is built from sales, but the free feed has no sales counts, so a thinly traded card can move on a few sales.</li>' +
      '<li>Prices by condition. The free feed has one market price per printing, and the lowest listing can be a played or damaged copy. This matters most for vintage cards.</li>' +
      '<li>Graded prices for the whole catalog. PSA prices are looked up only for the cards in the issue.</li>' +
      '<li>Reddit and X chatter. Not connected yet.</li></ul>' +
      '<h2>The fine print</h2><p>This is market information, not financial advice. A price that rose last week can fall next week. Not affiliated with or endorsed by Nintendo, The Pokémon Company, TCGplayer or eBay. Card images are shown only to identify the cards being priced.</p></div>';
  }

  // Shrink the masthead until it fits its line, whatever font actually loaded.
  function fitMasthead() {
    var el = screen.querySelector('.masthead');
    if (!el) return;
    el.style.fontSize = '';
    var size = parseFloat(getComputedStyle(el).fontSize), guard = 0;
    while (el.scrollWidth > el.clientWidth && size > 40 && guard++ < 60) { size -= 3; el.style.fontSize = size + 'px'; }
  }
  window.addEventListener('resize', fitMasthead);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitMasthead);

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
      fitMasthead();
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
