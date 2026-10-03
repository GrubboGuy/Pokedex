/* Pokédex daily: renders the picks written by the data job. No build step. */
(function () {
  'use strict';

  var screen = document.getElementById('screen');
  var sideEl = document.getElementById('side');
  var issueNoEl = document.getElementById('issue-no');
  var cache = {};
  var indexPromise = null, searchPromise = null, setCache = {};
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
    if (p.chSince != null) return move(p.chSince);
    var gap = Math.round((1 - p.low / p.price) * 100);
    return '<span class="move gap">asking from ' + gap + '% under</span>';
  }
  function niceDate(iso, withYear) {
    var p = iso.split('-');
    return MONTHS[+p[1] - 1] + ' ' + (+p[2]) + (withYear === false ? '' : ', ' + p[0]);
  }
  function span(issue) { return issue.shortSpanDays || 7; }
  // When the picks were last refreshed, in the reader's own time zone.
  function updated(issue, withTime) {
    var d = issue.generatedAt ? new Date(issue.generatedAt) : null;
    if (!d || isNaN(d)) return niceDate(issue.date, false);
    var day = MONTHS[d.getMonth()] + ' ' + d.getDate();
    if (!withTime) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ', ' + day;
    var h = d.getHours(), m = d.getMinutes();
    return day + ', ' + (h % 12 || 12) + ':' + pad(m, 2) + (h < 12 ? ' AM' : ' PM');
  }
  // True when the picks on screen were made today, by the reader's own calendar.
  function madeToday(issue) {
    var d = issue.generatedAt ? new Date(issue.generatedAt) : null, now = new Date();
    return !!d && !isNaN(d) && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }
  var today = '';  // ' today' while the picks on screen were made today, otherwise empty; set on each page load
  // Which printing of the card this is, said only when it matters: any special printing
  // (reverse holo, 1st Edition and so on), or a plain one when the same card also comes in another.
  function printLabel(p) {
    if (p.kind === 'sealed' || !p.printing) return '';
    var plain = p.printing === 'Normal' || p.printing === 'Holofoil';
    var hasOther = (p.variants || []).some(function (v) { return String(v.productId) === String(p.productId) && v.printing !== p.printing; });
    return plain && !hasOther ? '' : (PRINTS[p.printing] || p.printing);
  }
  function printChip(p) {
    var label = printLabel(p);
    return label ? '<span class="print' + (/holo/i.test(p.printing) ? ' foil' : (/1st/i.test(p.printing) ? ' first' : '')) + '">' + esc(label) + '</span>' : '';
  }
  function rarityChip(p) {
    return p.kind !== 'sealed' && p.rarity && p.rarity !== 'None' && p.rarity !== 'Unconfirmed' ? '<span class="rar">' + esc(p.rarity) + '</span>' : '';
  }
  function tags(p, tagName) {
    var html = (p.isNew ? '<span class="new">New' + today + '</span>' : '') + printChip(p) + rarityChip(p) + eraChip(p.era);
    return html ? '<' + (tagName || 'div') + ' class="tags">' + html + '</' + (tagName || 'div') + '>' : '';
  }
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

  // One score for every pick, 1 to 99. What it measures depends on the list the pick is in.
  // Score colour: red at 0, yellow at 50, green at 100. Tuned to stay readable on the dark score chip.
  function scoreColor(n) {
    n = Math.max(0, Math.min(100, +n || 0));
    var hue = n <= 50 ? 2 + n / 50 * 48 : 50 + (n - 50) / 50 * 85;
    return 'hsl(' + Math.round(hue) + ', ' + Math.round(88 - n * 0.2) + '%, ' + Math.round(62 - n * 0.1) + '%)';
  }
  function score(pick) {
    return '<span class="score"' + (pick.score >= 99 ? ' data-top-score' : '') + ' style="--sc:' + scoreColor(pick.score) + '" title="Score, from 1 to 99"><b>' + pick.score + '</b><small>Score</small></span>';
  }
  var GO = '<span class="go">Details<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span>';
  function scoreMeans(cat, p) {
    var kind = p.scoreLabel;
    if (kind === 'Swing') return 'how big the recent price move is, up or down';
    if (kind === 'Rebound') return 'how strong the signs are that the price will come back';
    if (kind === 'Steady') return 'how little the price has moved';
    if (kind === 'Deal') return 'how far below its usual price it is';
    return 'how fast the price is rising';
  }
  function verdict(p) {
    if (p.scoreLabel === 'Deal') return p.score >= 80 ? 'Deep discount' : (p.score >= 70 ? 'Solid discount' : 'Mild discount');
    if (p.scoreLabel === 'Swing') return p.ch7 > 0 ? 'Big jump' : 'Sharp drop';
    if (p.scoreLabel === 'Rebound') return p.score >= 72 ? 'Strong signs' : (p.score >= 64 ? 'Good signs' : 'Early signs');
    if (p.scoreLabel === 'Steady') return p.score >= 85 ? 'Rock steady' : 'Steady';
    return p.score >= 80 ? 'Red hot' : (p.score >= 65 ? 'Hot' : 'Warming up');
  }
  // Titles saved in older issues end in "this week"; the time word is added here only when it is true.
  function plainTitle(cat) { return String(cat.title).replace(/ (this week|today)$/, ''); }
  function listTitle(cat) {
    return (cat.id.indexOf('hot-') === 0 ? '🔥 ' : '') + plainTitle(cat);
  }
  // A TCGplayer link that opens the copies for sale of this exact printing, cheapest first.
  function lowUrl(url, productId, printing, sealed, nearMint) {
    var u = String(url || 'https://www.tcgplayer.com/product/' + productId).split('?')[0];
    return u + '?Language=English' + (!sealed && printing ? '&Printing=' + encodeURIComponent(printing).replace(/%20/g, '+') : '') +
      (nearMint ? '&Condition=Near+Mint' : '') + '&page=1';
  }
  var OUT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16l8-8M9.5 8H16v6.5"/></svg>';
  // An eBay search for this exact card. sold=false: copies for sale now, cheapest first with shipping counted.
  // sold=true: what has recently sold.
  function ebayUrl(o, sold) {
    var words = [shortName(o.name)];
    if (!o.sealed) {
      if (o.number) words.push(String(o.number).split('/')[0]);
      if (o.set) words.push(String(o.set).replace(/^[A-Z0-9]+\s*[:\-]\s*/, ''));
      if (/reverse/i.test(o.printing || '')) words.push('reverse holo');
      if (/1st/i.test(o.printing || '')) words.push('1st edition');
    } else words.push('pokemon');
    return 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(words.join(' ')).replace(/%20/g, '+') +
      (sold ? '&LH_Sold=1&LH_Complete=1' : '&_sop=15&LH_BIN=1');
  }
  // Links to where the card is for sale right now, lowest price first. No price is promised on the link itself.
  function shopLinks(p, cls) {
    var o = { name: p.name, number: p.number, set: p.set, printing: p.printing, sealed: p.kind === 'sealed' };
    return '<div class="shop' + (cls ? ' ' + cls : '') + '"><span>' + (cls ? 'Lowest prices now' : 'Lowest prices') + '</span>' +
      '<a href="' + esc(lowUrl(p.url, p.productId, p.printing, o.sealed)) + '" target="_blank" rel="noopener">TCGplayer' + OUT + '</a>' +
      '<a href="' + esc(ebayUrl(o, false)) + '" target="_blank" rel="noopener">eBay' + OUT + '</a></div>';
  }
  function where(p) {
    var bits = [p.set];
    if (p.number) bits.push('#' + p.number);
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
      // With no issue number, show today's edition: the picks as refreshed this morning.
      // A numbered issue is the copy kept from the day it was cut.
      var n = number || 'today';
      if (!cache[n]) {
        cache[n] = number ? getJSON('data/issue-' + number + '.json')
          : getJSON('data/today.json').catch(function () { return getJSON('data/issue-' + index[0].number + '.json'); });
      }
      return cache[n].then(function (issue) { return { issue: issue, kept: !!number, latest: index[0].number, index: index }; });
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
  function base(ctx) { return ctx.kept ? '#/issue/' + ctx.issue.number : '#'; }

  // ---------- chrome ----------
  // The sidebar: a slim strip of section dots that opens into a wider list with the section names.
  // activeId is '' for the front page, null for none.
  function renderSide(ctx, activeId) {
    var b = base(ctx);
    var rows = [['', 'Front page', 'front', 0]].concat(ctx.issue.categories.map(function (c) {
      return [c.id, listTitle(c), TONE[c.id] || 'steady', ctx.kept ? 0 : c.picks.filter(function (p) { return p.isNew; }).length];
    }));
    sideEl.classList.remove('open');
    sideEl.innerHTML = '<div class="side-in"><button type="button" class="side-toggle" aria-expanded="false" aria-label="Show section names">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="bars" d="M4 7h16M4 12h16M4 17h16"/><path class="shut" d="M15 6l-6 6 6 6"/></svg><span>Sections</span></button>' +
      rows.map(function (r) {
        return '<a class="t-' + r[2] + '" href="' + b + (r[0] ? '/list/' + r[0] : '/') + '" title="' + esc(r[1]) + '"' + (r[0] === activeId ? ' aria-current="true"' : '') + '>' +
          '<i class="dot"></i><span>' + esc(r[1]) + '</span>' + (r[3] ? '<b class="n" aria-label="' + r[3] + ' new">' + r[3] + '</b>' : '') + '</a>';
      }).join('') + '</div>';
    var box = sideEl.firstChild, on = box.querySelector('[aria-current]');
    if (on && (on.offsetTop < box.scrollTop || on.offsetTop + on.offsetHeight > box.scrollTop + box.clientHeight)) {
      box.scrollTop = Math.max(0, on.offsetTop - (box.clientHeight - on.offsetHeight) / 2);
    }
  }
  function setSide(open) {
    sideEl.classList.toggle('open', open);
    var t = sideEl.querySelector('.side-toggle');
    if (t) { t.setAttribute('aria-expanded', open ? 'true' : 'false'); t.setAttribute('aria-label', open ? 'Hide section names' : 'Show section names'); }
  }
  sideEl.addEventListener('click', function (e) {
    if (e.target.closest('.side-toggle')) setSide(!sideEl.classList.contains('open'));
    else if (e.target.closest('a') || !e.target.closest('.side-in')) setSide(false);  // picked a section, or tapped outside the open list
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setSide(false); });
  function sectionPager(ctx, activeId) {
    var b = base(ctx), cats = ctx.issue.categories;
    var order = [{ id: '', name: 'Front page' }].concat(cats.map(function (c) { return { id: c.id, name: c.short || c.title }; }));
    var i = order.map(function (o) { return o.id; }).indexOf(activeId);
    var prev = order[i - 1], next = order[i + 1];
    var href = function (o) { return b + (o.id ? '/list/' + o.id : '/'); };
    return '<nav class="pager" aria-label="Sections">' +
      (prev ? '<a class="prev" href="' + href(prev) + '"><small>Previous section</small><b>' + esc(prev.name) + '</b></a>' : '<span></span>') +
      (next ? '<a class="next" href="' + href(next) + '"><small>Next section</small><b>' + esc(next.name) + '</b></a>' : '<span></span>') +
      '</nav>';
  }

  // ---------- views ----------
  function frontView(ctx) {
    var issue = ctx.issue, b = base(ctx), days = span(issue);
    var coverCat = null, coverPick = null, total = 0, fresh = 0;
    issue.categories.forEach(function (c) {
      total += c.picks.length;
      c.picks.forEach(function (p) {
        if (p.isNew) fresh++;
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
        '<p class="lead-line"><b>' + esc(shortName(p.name)) + '</b>' + (printLabel(p) ? '<span class="lead-print">' + esc(printLabel(p)) + '</span>' : '') + '<span class="price">' + money(p.price) + '</span>' + headlineMove(p) + '</p></span>' +
        '<span class="sec-art">' + art + '</span></a></li>';
    }).join('');

    var s = issue.stats;
    return '<header class="front-head"><div class="dateline eyebrow"><span>Issue ' + pad(issue.number, 2) + '</span><span>' + (ctx.kept ? 'Prices as of ' + niceDate(issue.date) : 'Updated ' + updated(issue)) + '</span></div>' +
      '<h1>' + (ctx.kept ? 'Picks from ' + niceDate(issue.date, false) : (today ? 'Today&#39;s picks' : 'Latest picks')) + '</h1>' +
      '<p class="deck">' + total + ' cards and sealed products worth a look, chosen by rule from ' + Number(s.productsScanned).toLocaleString('en-US') + ' tracked products.</p>' +
      '<button type="button" class="cta" id="strategy">Today&#39;s strategy<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></header>' +
      '<div class="' + tone(coverCat) + '"><a class="hero" href="' + coverHref + '">' + img(coverPick, 'card-img', true) +
        '<span><span class="eyebrow"><i class="dot"></i>Top pick, ' + esc(coverCat.short || coverCat.title) + '</span>' +
        '<h2>' + esc(shortName(coverPick.name)) + '</h2><p class="where">' + esc(where(coverPick)) + '</p>' + tags(coverPick, 'span') +
        '<span class="figures"><span class="price">' + money(coverPick.price) + '</span>' + headlineMove(coverPick) + '</span><span class="foot">' + score(coverPick) + GO + '</span></span>' +
        '<span class="hero-why deck">' + esc(coverPick.reason) + '</span></a>' + shopLinks(coverPick, 'under') + '</div>' +
      '<h2 class="strip">Sections <span>' + issue.categories.length + ' lists, ' + total + ' picks' + (fresh && !ctx.kept ? ', ' + fresh + ' new' + today : '') + '</span></h2>' +
      '<ol class="sections">' + sections + '</ol>' +
      '<div class="block dark stats"><div><b>' + Number(s.productsScanned).toLocaleString('en-US') + '</b><span>products checked</span></div>' +
        '<div><b>' + s.snapshots + '</b><span>days of prices since ' + niceDate(s.historyFrom, false) + '</span></div>' +
        '<div><b>' + days + ' days</b><span>covered by each price change shown</span></div></div>' +
      '<p class="note fine">Prices are TCGplayer market prices, meaning what each card has recently sold for, as of ' + niceDate(issue.date) + '. The score on each pick runs from 1 to 99. This is market information, not financial advice; a price that went up can come back down. ' +
        '<a href="#/how">What the numbers mean</a>. Not affiliated with or endorsed by Nintendo, The Pokémon Company, TCGplayer or eBay.</p>' +
      sectionPager(ctx, '');
  }

  function listView(ctx, id) {
    var issue = ctx.issue, b = base(ctx), days = span(issue);
    var idx = issue.categories.map(function (c) { return c.id; }).indexOf(id);
    var cat = issue.categories[idx];
    if (!cat) return notFound();
    var lead = cat.picks[0];
    var rest = cat.picks.slice(1).map(function (p) {
      return '<div class="pick"><a class="pick-main" href="' + b + '/card/' + cat.id + '/' + p.rank + '">' +
        '<div class="pick-art"><span class="rank">' + p.rank + '</span>' + img(p) + '</div>' +
        '<div class="pick-info"><h3>' + esc(shortName(p.name)) + '</h3><p class="where">' + esc(where(p)) + '</p>' +
        tags(p) +
        '<div class="figures"><span class="price">' + money(p.price) + '</span>' + headlineMove(p) + '</div><div class="foot">' + score(p) + GO + '</div></div></a>' +
        shopLinks(p) + '</div>';
    }).join('');
    var trendNote = (lead.ch7 != null ? 'The big price is the TCGplayer market price: what the card has recently sold for. The % beside it is how much that price changed over the last ' + days + ' days.'
      : 'The big price is the TCGplayer market price: what the product has recently sold for. The % beside it is how much that price has changed since ' + (lead.since ? niceDate(lead.since, false) : 'we started tracking it') + '.') +
      ' Score: ' + scoreMeans(cat, lead) + ', from 1 to 99. Prices as of ' + niceDate(issue.date) + '. The TCGplayer and eBay links under each card open what is for sale right now, lowest price first.';
    return '<div class="' + tone(cat) + '"><header class="sec-head band"><span class="eyebrow"><i class="dot"></i>Section ' + (idx + 1) + ' of ' + issue.categories.length + '</span>' +
      '<h1>' + esc(listTitle(cat)) + '</h1><p class="deck">' + esc(cat.blurb) + '</p></header>' +
      '<p class="tap-hint"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V10m0 0V8.5a1.5 1.5 0 0 1 3 0V11m0-.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.6a5 5 0 0 1-4-2l-3.1-4.2a1.5 1.5 0 0 1 2.3-1.9L9 14.5"/></svg>Tap any card for its sold prices, graded prices and price history.</p>' +
      '<a class="lead" href="' + b + '/card/' + cat.id + '/' + lead.rank + '">' +
        '<div class="lead-art"><span class="rank">1</span>' + img(lead, 'card-img', true) + '</div>' +
        '<div><h2>' + esc(shortName(lead.name)) + '</h2><p class="where">' + esc(where(lead)) + '</p>' +
        tags(lead) +
        '<div class="figures"><span class="price">' + money(lead.price) + '</span>' + headlineMove(lead) + '</div><div class="foot">' + score(lead) + GO + '</div></div>' +
        '<p class="lead-why deck">' + esc(lead.reason) + '</p></a>' + shopLinks(lead, 'under') +
      '<div class="picks">' + rest + '</div>' +
      '<div class="block tint aside"><b>How this list is picked</b><p>' + esc(cat.rule) + ' ' + cat.eligible + ' met this rule' + today + '; these are the top ' + cat.picks.length + '.</p></div>' +
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
    return '<section class="block"><h2>Price history <span>' + niceDate(series[0][0], false) + ' to ' + niceDate(series[series.length - 1][0], false) + '</span></h2>' + chart(series) +
      (series.length > 1 ? '<details class="points"><summary>Show the price on each of ' + series.length + ' days</summary><table>' + rows + '</table></details>' : '') + '</section>';
  }

  function breakdown(p, days) {
    function row(label, value) { return '<div class="rowb"><dt>' + label + '</dt><dd>' + value + '</dd></div>'; }
    var rows = [];
    if (p.ch7 != null) rows.push(row('Last ' + days + ' days', move(p.ch7)));
    else if (p.chSince != null) rows.push(row('Since ' + niceDate(p.since, false), move(p.chSince)));
    if (p.ch30 != null) rows.push(row('Last 30 days', move(p.ch30)));
    if (p.ch90 != null) rows.push(row('Last 90 days', move(p.ch90)));
    var gap = p.low / p.price - 1, g = Math.round(Math.abs(gap) * 100);
    rows.push(row('Lowest asking price', money(p.low)));
    if (p.activity != null && p.ch7 != null) rows.push(row('Sells', p.activity >= 0.6 ? 'Often' : (p.activity >= 0.34 ? 'Regularly' : 'Not often')));
    return rows.join('');
  }

  function versusText(x) {
    var v = Math.round(Math.abs(x) * 100);
    return v === 0 ? 'Same as TCGplayer' : v + '% ' + (x < 0 ? 'below' : 'above') + ' TCGplayer';
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
      out += '<section class="block"><h2>Sold on eBay <span>' + esc(tierName(ek[0])) + (p.kind === 'sealed' ? '' : ', ungraded') + '</span></h2><div class="figs">' +
        '<div><small>Most recent sale</small><b>' + money(t.avg, true) + '</b><span>' + (on(t) || 'date not given') + '</span></div>' +
        '<div><small>Typical price, last 30 days</small><b>' + (m30 != null ? money(m30, true) : 'n/a') + '</b><span>' + (versus != null && p.price ? versusText(versus / p.price - 1) : (m7 != null ? 'Last 7 days: ' + money(m7, true) : '')) + '</span></div>' +
        '<div><small>Number of sales</small><b>' + (t.saleCount != null ? Number(t.saleCount).toLocaleString('en-US') : 'n/a') + '</b><span>' + (t.approxSaleCount ? 'a rough count' : '') + '</span></div></div>';
      if (ek.length > 1) {
        out += '<table class="cond" style="margin-top:14px"><tr><th>Other conditions on eBay</th><th>Most recent sale</th><th>Sales</th></tr>' + ek.slice(1).map(function (k) {
          return '<tr><td>' + esc(tierName(k)) + '</td><td>' + money(ebay[k].avg) + '</td><td class="muted">' + (ebay[k].saleCount != null ? ebay[k].saleCount : '') + '</td></tr>';
        }).join('') + '</table>';
      }
      out += '</section>';
    } else {
      out += '<section class="block sunk"><h2>Sold on eBay</h2><p class="note">We have no eBay sales on record for this one. The button at the bottom opens its recent sales on eBay.</p></section>';
    }
    var tk = keys(tcg);
    if (tk.length) {
      out += '<section class="block sunk"><h2>Sold on TCGplayer' + (p.kind === 'sealed' ? '' : ', by condition') + '</h2><table class="cond"><tr><th>' + (p.kind === 'sealed' ? 'Product' : 'Condition') + '</th><th>Latest price</th><th>30-day average</th><th>Sales</th></tr>' + tk.map(function (k) {
        return '<tr><td>' + esc(tierName(k)) + '</td><td>' + money(tcg[k].avg) + '</td><td class="muted">' + (tcg[k].avg30d != null ? money(tcg[k].avg30d) : '') + '</td><td class="muted">' + (tcg[k].saleCount != null ? Number(tcg[k].saleCount).toLocaleString('en-US') : '') + '</td></tr>';
      }).join('') + '</table></section>';
    }
    return out;
  }

  // ---------- other versions of a card ----------
  var PRINTS = { 'Normal': 'Non-holo', 'Holofoil': 'Holo', 'Reverse Holofoil': 'Reverse holo', '1st Edition': '1st Edition', '1st Edition Holofoil': '1st Edition holo', 'Unlimited': 'Unlimited', 'Unlimited Holofoil': 'Unlimited holo' };
  function baseName(n) { return String(n || '').split(/\s+-\s+|\s*[(\[]/)[0].trim().toLowerCase(); }
  // What sets a version apart: its printing, or for a separately sold copy its stamp or pattern.
  function variantLabel(main, v) {
    var print = PRINTS[v.printing] || v.printing;
    if (String(v.productId) === String(main.productId)) return [print, ''];
    var tags = [];
    String(v.name).replace(/[(\[]([^)\]]+)[)\]]/g, function (_, t) { if (String(main.name).indexOf(t) < 0) tags.push(t); });
    var tag = tags.join(', ') || 'Other version';
    return [tag, tag.toLowerCase() === print.toLowerCase() ? '' : print];
  }
  function variantSlotButton(list) {
    return list && list.length ? '<button type="button" class="var-btn" aria-expanded="false" aria-controls="variants">Variants<b>' + list.length + '</b><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>' : '';
  }
  // The official card back, loaded from the Pokémon TCG site; a drawn stand-in is used if it cannot load.
  var CARD_BACK = 'https://tcg.pokemon.com/assets/img/global/tcg-card-back.jpg';
  function variantPanel(main, list, setName) {
    if (!list || !list.length) return '';
    return '<section class="variants" id="variants" hidden><div class="var-grid">' + list.map(function (v) {
      var label = variantLabel(main, v), other = v.set && v.set !== setName ? v.set : '';
      var say = [label[0], label[1], other].filter(Boolean).join(', ');
      return '<button type="button" class="var" aria-pressed="false" aria-label="' + esc(say) + ': market price ' + money(v.price) + '. Tap to flip.">' +
        '<span class="var-card"><span class="var-face var-front"><img src="' + esc(productImage(v.productId)) + '" alt="" loading="lazy"></span>' +
        '<span class="var-face var-back"><img src="' + CARD_BACK + '" data-small="img/card-back.svg" referrerpolicy="no-referrer" alt=""><b>' + esc(label[0]) + '</b><strong>' + money(v.price, true) + '</strong><small>market price</small></span></span>' +
        '<span class="var-name">' + esc(label[0]) + (label[1] ? '<small>' + esc(label[1]) + '</small>' : '') + '</span></button>';
    }).join('') + '</div><p class="note">Tap a card to flip it and see what that version sells for.</p></section>';
  }

  function buyLinks(o) {
    return '<div class="buy"><a href="' + esc(lowUrl(o.url, o.productId, o.printing, o.sealed)) + '" target="_blank" rel="noopener">Lowest on TCGplayer</a>' +
      '<a href="' + esc(ebayUrl(o, false)) + '" target="_blank" rel="noopener">Lowest on eBay</a>' +
      (o.sealed ? '' : '<a class="alt" href="' + esc(lowUrl(o.url, o.productId, o.printing, false, true)) + '" target="_blank" rel="noopener">Near Mint on TCGplayer</a>') +
      '<a class="alt" href="' + esc(ebayUrl(o, true)) + '" target="_blank" rel="noopener">Recent eBay sales</a></div>';
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
        var basis = d.sales ? d.sales + (d.sales === 1 ? ' sale' : ' sales') : ({ high: 'many sales', medium: 'some sales', low: 'few sales' }[String(d.confidence || '').toLowerCase()] || '');
        return '<div><small>' + g[1] + '</small><b>' + money(d.price, true) + '</b><span>' + (basis ? 'based on ' + basis : '') + '</span></div>';
      });
      if (slabs.length) graded = '<section class="block tint"><h2>Graded copies, sold on eBay <span>PSA</span></h2><div class="figs' + (slabs.length === 2 ? ' two' : '') + '">' + slabs.join('') + '</div></section>';
    }
    var prev = cat.picks[p.rank - 2], next = cat.picks[p.rank];
    var listHref = b + '/list/' + cat.id;
    var hrefOf = function (x) { return b + '/card/' + cat.id + '/' + x.rank; };
    var confText = { High: 'it sells often, we have a long price history, and sellers are asking close to the market price', Medium: 'we have only part of its price history, or sellers are asking a bit more or less than the market price', Low: 'we have little price history for it, or sellers are asking far more or less than the market price' }[p.confidence];
    var price = money(p.price);

    return '<div class="' + tone(cat) + '"><header class="entry-head band dark"><a class="back" href="' + listHref + '">Back to ' + esc(cat.short || cat.title) + '</a>' +
      '<span class="eyebrow"><i class="dot"></i>Card details, pick ' + p.rank + ' of ' + cat.picks.length + '</span><h1>' + esc(shortName(p.name)) + '</h1>' +
      '<p class="where">' + esc(where(p)) + '</p>' +
      tags(p) + '</header>' +
      '<div class="entry-main"><div class="slot">' + img(p, 'card-img', true) + variantSlotButton(p.variants) + '</div>' +
      '<div class="entry-price"><span class="eyebrow">TCGplayer market price</span><div class="big' + (price.length > 7 ? ' long' : '') + '">' + price + '</div>' +
      '<p class="sub">What it has recently sold for.</p>' +
      '<span class="conf ' + p.confidence.toLowerCase() + '">Price reliability: ' + esc(p.confidence) + '</span></div></div>' +
      variantPanel(p, p.variants, p.set) +
      shopLinks(p, 'under') +
      '<section class="verdict"><div class="num"' + (p.score >= 99 ? ' data-top-score' : '') + ' style="--sc:' + scoreColor(p.score) + '"><b>' + p.score + '</b><small>Score</small><em>' + verdict(p) + '</em>' +
      '<span class="meter" aria-hidden="true"><i style="left:' + Math.max(3, Math.min(97, p.score)) + '%"></i></span></div>' +
      '<dl>' + breakdown(p, days) + '</dl>' +
      '<p class="verdict-note">In this list the score shows ' + scoreMeans(cat, p) + '. It runs from 1 to 99; higher is stronger.</p></section>' +
      '<section class="block tint"><h2>Why it is here</h2><p class="why">' + esc(p.reason) + '</p></section>' +
      soldBlocks(p) + graded + chartBlock(p.series) +
      '<p class="note fine">The market price is what the ' + esc(p.printing) + ' printing has recently sold for on TCGplayer, from <a href="https://tcgcsv.com/" rel="noopener">TCGCSV</a>, as of ' + niceDate(issue.date) + '. The lowest asking price is the cheapest TCGplayer listing on that day, in any condition and before shipping, so a clean copy delivered will usually cost more and that listing may be gone. The TCGplayer and eBay links open what is for sale right now. ' +
      (p.sold ? 'eBay and by-condition prices are from <a href="https://poketrace.com/" rel="noopener">PokeTrace</a>, as of ' + niceDate(p.sold.date) + '; eBay sale numbers are approximate. ' : '') +
      (p.graded ? 'Graded prices are from completed eBay sales, from <a href="https://www.pokemonpricetracker.com/" rel="noopener">PokemonPriceTracker</a>, as of ' + niceDate(p.graded.date) + '; they can mix printings, so check the graded card matches this one. ' : '') +
      'Price reliability is ' + esc(p.confidence) + ' because ' + confText + '. <a href="#/how">What the numbers mean</a>. Not financial advice.</p>' +
      buyLinks({ name: p.name, number: p.number, set: p.set, url: p.url, productId: p.productId, printing: p.printing, sealed: p.kind === 'sealed' }) +
      '<nav class="pager" aria-label="Picks">' +
      '<a class="prev" href="' + (prev ? hrefOf(prev) : listHref) + '"><small>' + (prev ? 'Previous pick' : 'Back to') + '</small><b>' + esc(prev ? shortName(prev.name) : (cat.short || cat.title)) + '</b></a>' +
      '<a class="next" href="' + (next ? hrefOf(next) : listHref) + '"><small>' + (next ? 'Next pick' : 'Back to') + '</small><b>' + esc(next ? shortName(next.name) : (cat.short || cat.title)) + '</b></a></nav></div>';
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
      // Other versions: this product's other printings, then same-name, same-number copies sold separately.
      var others = [];
      if (!it[4] && it[3]) {
        var mine = baseName(it[1]);
        data.items.forEach(function (x) {
          if (x[4] || x[3] !== it[3] || baseName(x[1]) !== mine) return;
          if (x[2] !== it[2] && String(it[3]).indexOf('/') < 0) return;
          x[6].forEach(function (q) {
            if (x[0] === it[0] && q[0] === pr[0]) return;
            others.push({ productId: x[0], name: x[1], printing: q[0], price: q[1], set: data.sets[x[2]][1] });
          });
        });
        others.sort(function (a, b) { return (a.productId !== it[0]) - (b.productId !== it[0]) || b.price - a.price; });
        others = others.slice(0, 12);
      }
      var rows = [];
      if (pr[3] != null) rows.push('<div><small>Recent change</small><b>' + move(pr[3]) + '</b></div>');
      if (pr[4] != null) rows.push('<div><small>Last 30 days</small><b>' + move(pr[4]) + '</b></div>');
      if (q != null) rows.push('<div><small>Since ' + niceDate(first[0], false) + '</small><b>' + move(q) + '</b></div>');
      return '<div class="' + (eraTone(era) || 't-steady') + '"><header class="entry-head band dark"><a class="back" href="#/search">Back to search</a>' +
        '<span class="eyebrow"><i class="dot"></i>' + (it[4] ? 'Sealed product details' : 'Card details') + '</span><h1>' + esc(shortName(it[1])) + '</h1>' +
        '<p class="where">' + esc([s[1], it[3] ? '#' + it[3] : '', it[5] || ''].filter(Boolean).join(', ')) + '</p>' +
        (era ? '<div class="tags">' + eraChip(era) + '</div>' : '') + '</header>' +
        '<div class="entry-main"><div class="slot">' + img(pick, 'card-img', true) + variantSlotButton(others) + '</div>' +
        '<div class="entry-price"><span class="eyebrow">TCGplayer market price</span><div class="big' + (price.length > 7 ? ' long' : '') + '">' + price + '</div>' +
        '<p class="sub">' + (pr[2] != null ? 'What it has recently sold for.' : 'What it has recently sold for. None were for sale when prices were last checked.') + '</p>' + chips + '</div></div>' +
        variantPanel({ productId: it[0], name: it[1] }, others, s[1]) +
        shopLinks({ url: null, productId: it[0], name: it[1], number: it[3], set: s[1], printing: pr[0], kind: pick.kind }, 'under') +
        (rows.length ? '<section class="block tint"><h2>Price changes</h2><div class="figs' + (rows.length === 2 ? ' two' : '') + '">' + rows.join('') + '</div></section>' : '') +
        chartBlock(series) +
        '<p class="note fine">The market price is what the ' + esc(pr[0]) + ' printing has recently sold for on TCGplayer, from <a href="https://tcgcsv.com/" rel="noopener">TCGCSV</a>, as of ' + niceDate(data.date) + '. eBay and graded prices are looked up only for the cards in the picks.</p>' +
        buyLinks({ name: it[1], number: it[3], set: s[1], url: null, productId: it[0], printing: pr[0], sealed: !!it[4] }) + '</div>';
    });
  }

  function issuesView(ctx) {
    var rows = ctx.index.map(function (e) {
      return '<a class="issue-row" href="#/issue/' + e.number + '/"><img src="' + esc(e.coverImage || PLACEHOLDER) + '" alt="" loading="lazy">' +
        '<span><b>Issue ' + pad(e.number, 2) + '</b><span>Prices as of ' + niceDate(e.date) + '. ' + e.picks + ' picks. Top pick: ' + esc(shortName(e.coverName || '')) + '</span></span></a>';
    }).join('');
    return '<header class="page-head"><h1>Back issues</h1></header><section class="block">' + rows + '</section>' +
      '<section class="block sunk article"><p>The picks on the front page are refreshed every morning by 7 AM Eastern. Each Friday\u2019s picks are kept here as a numbered issue. Once four weeks of issues exist, each back issue will show how its picks did.</p></section>';
  }

  function howView(ctx) {
    var issue = ctx.issue, days = span(issue);
    var rules = issue.categories.map(function (c) { return '<li class="' + tone(c) + '"><i class="dot"></i><b>' + esc(plainTitle(c)) + '.</b> ' + esc(c.rule) + '</li>'; }).join('');
    var sources = issue.sources.map(function (s) { return '<li><a href="' + esc(s.url) + '" rel="noopener">' + esc(s.name) + '</a>. ' + esc(s.note) + '</li>'; }).join('');
    return '<header class="page-head"><h1>How it works</h1>' +
      '<p class="deck">Every day a job copies the TCGplayer market price of every English Pokémon single and sealed product, about ' + Number(issue.stats.productsScanned).toLocaleString('en-US') +
      ' products. Every morning it compares the latest prices with a week, 30 days and 90 days ago and re-runs the rules below, so the picks are fresh by 7 AM Eastern. Nothing is picked by hand.</p></header>' +
      (days !== 7 ? '<section class="block tint t-sale article"><p>These picks measure their recent price change over ' + days + ' days instead of 7, because the saved price history has a gap in late September 2026. It returns to 7 days once a full week of daily prices is on file.</p></section>' : '') +
      '<section class="block dark article"><h2>What the numbers mean</h2><ul>' +
      '<li><b>Market price.</b> TCGplayer\u2019s figure for what a card has recently sold for. It is the main price shown everywhere.</li>' +
      '<li><b>Lowest asking price.</b> The cheapest TCGplayer listing when prices were last checked, in any condition and before shipping. Treat it as a starting point, not a quote: that copy may be played, may have sold since, and shipping is extra. The TCGplayer and eBay links on every card open what is for sale right now, lowest price first.</li>' +
      '<li><b>Price change.</b> How much the market price went up or down over the days shown.</li>' +
      '<li><b>Usual price.</b> The middle price over the last 90 days: half the days were higher, half were lower. One odd day does not throw it off.</li>' +
      '<li><b>Score.</b> One number from 1 to 99 on every pick; higher is stronger. Its colour runs from red at the low end through yellow in the middle to green at the top. What it measures depends on the list: how fast a price is rising, how big a discount is, how steady a price is, how big a move is, or how strong the signs of a comeback are. Each card page says which.</li>' +
      '<li><b>Price reliability.</b> High when the card sells often, we have a long price history and sellers are asking close to the market price. Low when any of those is missing.</li>' +
      '<li><b>Sells often, regularly or not often.</b> How frequently the market price changed from day to day. A price that never changes usually means nothing is selling.</li></ul></section>' +
      '<section class="block article"><h2>Where the numbers come from</h2><ul>' + sources + '</ul></section>' +
      '<section class="block article"><h2>The rule for each list</h2><ul style="list-style:none;padding-left:0">' + rules + '</ul></section>' +
      '<section class="block sunk article"><h2>Checks on every pick</h2><ul>' +
      '<li>It must have a market price today and at least one copy for sale now.</li>' +
      '<li>It must actually sell. A card whose price never changes is left out.</li>' +
      '<li>For rising picks, the lowest asking price must be between 30% below and 25% above the market price, so sellers are actually listing it near the price shown.</li>' +
      '<li>A jump of more than 300% in the short period is treated as a data error and dropped.</li>' +
      '<li>At most three picks per set in a list, no card appears in two lists, and products not released yet are left out.</li></ul></section>' +
      '<section class="block article"><h2>What this free version cannot see</h2><ul>' +
      '<li>Each eBay sale one by one. For the picks we show the most recent sale price, the typical price and how many sold. The "Recent eBay sales" button on every card opens the actual sales on eBay.</li>' +
      '<li>How many copies sold, for every card. We only have that for the picks themselves.</li>' +
      '<li>Sealed price changes before October 2026. Our older price history covers single cards only. Until a full week of sealed prices is saved, the sealed list shows what has risen since October 1, and it is left out on days when too few products qualify.</li>' +
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
    screen.innerHTML = html;
    wireChart(screen);
    window.scrollTo(0, 0);
    setTimeout(watchTopScores, 300);  // after the jump back to the top has settled
  }
  function fail(err) {
    show(err && err.message === 'empty'
      ? '<p class="empty">The first issue has not been built yet. It appears here after the data job runs.</p>'
      : '<p class="empty">Could not load this page. Check your connection and reload.</p>');
  }
  // Pages outside the picks (search, a searched card) still show the sidebar, for today's sections.
  function sideFor(activeId) {
    getIssue(null).then(function (ctx) { renderSide(ctx, activeId); }).catch(function () {});
  }
  function route() {
    var parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    var number = null;
    if (parts[0] === 'issue') { number = parseInt(parts[1], 10) || null; parts = parts.slice(2); }
    var view = parts[0] || 'front';

    if (view === 'search') {
      setNav('search'); sideFor(null); screen.classList.remove('detail');
      show(searchView()); wireSearch();
      document.title = 'Search, Pokédex daily';
      return;
    }
    if (view === 'p') {
      setNav('search'); sideFor(null); screen.classList.add('detail');
      productView(parts[1], parts[2], decodeURIComponent(parts[3] || '')).then(show).catch(fail);
      return;
    }
    getIssue(number).then(function (ctx) {
      issueNoEl.textContent = ctx.kept ? 'Issue ' + pad(ctx.issue.number, 2) + ', ' + niceDate(ctx.issue.date, false) : 'Updated ' + updated(ctx.issue, true);
      var html;
      today = !ctx.kept && madeToday(ctx.issue) ? ' today' : '';
      if (view === 'list') { setNav('issue'); renderSide(ctx, parts[1]); html = listView(ctx, parts[1]); }
      else if (view === 'card') { setNav('issue'); renderSide(ctx, parts[1]); html = cardView(ctx, parts[1], parts[2]); }
      else if (view === 'issues') { setNav('issues'); renderSide(ctx, null); html = issuesView(ctx); }
      else if (view === 'how') { setNav('how'); renderSide(ctx, null); html = howView(ctx); }
      else { setNav('issue'); renderSide(ctx, ''); html = frontView(ctx); if (!route.warmed) { route.warmed = true; setTimeout(function () { new Image().src = 'img/guide.webp'; new Image().src = 'img/chromesby.webp'; new Image().src = 'img/hatguy.webp'; new Image().src = 'img/brother.webp'; }, 1500); } }
      screen.classList.toggle('kept', ctx.kept);
      screen.classList.toggle('detail', view === 'card');
      show(html);
      document.title = ctx.issue.title + ' daily' + (ctx.kept ? ', issue ' + ctx.issue.number : '');
    }).catch(fail);
  }

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
  // Once in a long while Chromesby shows up instead. He loves chrome and wants to change the world.
  var CHROMESBY_ODDS = 1 / 15;
  var CHROME = [
    'I\u2019m Chromesby. I love chrome. I\u2019m going to change the world.',
    'Chrome isn\u2019t a finish. It\u2019s a future.',
    'Imagine a world where everything is chrome. I do. Every night.',
    'One day every card will be chrome. I\u2019ll see to it personally.',
    'They said the world couldn\u2019t be chromed. They were dull.',
    'Matte is a choice. Chrome is a calling.',
    'I looked into the chrome. The chrome looked back. We agreed.',
    'Chrome doesn\u2019t judge. Chrome reflects.',
    'First we chrome the cards. Then the binders. Then the oceans.',
    'I was not born. I was polished.',
    'Change the world? I already have the finish for it.',
    'Chrome today. Chrome tomorrow. Chrome forever.',
    'Have you considered chrome?',
    'A chrome world is a kinder world. Shinier, too.',
    'My dream is simple. Every child, chrome.',
    'You can\u2019t spell change without... well. You can. But add chrome.'
  ];
  // Every so often the guy in the Venusaur hat turns up. He is fed up with his brother and sorry about him. Dad is the real boss.
  // One time in four his brother is peeking over his shoulder.
  var HATGUY_ODDS = 1 / 8, PEEK_ODDS = 1 / 4;
  var HATGUY = [
    'Hold on. HOLD ON. My brother is still talking.',
    'I was mid-sentence. He KNOWS I was mid-sentence.',
    'Can he not interrupt me for ONE pick? One.',
    'He has been \u201Calmost ready\u201D for twenty minutes.',
    'We\u2019d be done by now if my brother could read a price tag.',
    'He\u2019s been sleeving the same card since lunch.',
    'Sorry about my brother. He thinks reverse holo is a direction.',
    'I apologize for my brother. He alphabetized the binder by vibes.',
    'Sorry about him. He tried to haggle with a vending machine.',
    'I\u2019m so sorry. He called it \u201CPokey-man\u201D in front of the vendor.',
    'Apologies for my brother. He brought a calculator and no batteries.',
    'My brother says hi. I apologize for that too.',
    'Sorry, he sneezed on the display case. Again.',
    'I apologize in advance for whatever my brother is about to say.',
    'That\u2019s my call. Well. It\u2019s Dad\u2019s call. But I agree with it.',
    'Don\u2019t tell Dad I yelled. Actually, he heard. He always hears.'
  ];
  // Very, very rarely the brother pops up on his own and whispers. He is stressed, and very excited to trade.
  var BROTHER_ODDS = 1 / 40;
  var BROTHER = [
    'he\u2019s been like this all morning. i\u2019m so stressed. i just want to trade.',
    'psst. don\u2019t tell him i\u2019m here. my hands are shaking. i\u2019m so excited to trade.',
    'he said five more minutes an hour ago. i have a binder ready. please.',
    'he apologized for me again, didn\u2019t he. it\u2019s fine. it\u2019s fine. wanna trade?',
    'i haven\u2019t slept. i reorganized my trade binder twice. will you look at it?',
    'he thinks i\u2019m slow. i\u2019m thorough. ...do you have any doubles?',
    'everything\u2019s fine. i\u2019m sweating through this jacket. let\u2019s trade.',
    'i wore the tie for the trade. he says it\u2019s too much. is it too much?',
    'shh. if he hears me he\u2019ll start again. quick, what do you need?',
    'my heart is going so fast. in a good way. mostly. trade?',
    'i\u2019m not interrupting. i\u2019m whispering. it\u2019s different. so. trades?',
    'he yells because he cares. i think. anyway i brought my best cards.'
  ];
  var guide = null, guideTimer = null;
  // Every line gets its turn before any repeats.
  function dealer(lines) {
    var bag = [], last = -1;
    return function () {
      if (!bag.length) {
        bag = lines.map(function (_, i) { return i; });
        for (var i = bag.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = bag[i]; bag[i] = bag[j]; bag[j] = t; }
        if (bag[bag.length - 1] === last) bag.unshift(bag.pop());
      }
      last = bag.pop();
      return lines[last];
    };
  }
  var nextLine = dealer(WISDOM), nextChrome = dealer(CHROME), nextHatguy = dealer(HATGUY), nextBrother = dealer(BROTHER);
  function buildGuide() {
    guide = document.createElement('div');
    guide.className = 'guide';
    guide.innerHTML = '<p class="guide-say" role="status" aria-live="polite"><b></b><span></span></p><img class="peek" alt=""><img class="who" alt="">';
    guide.addEventListener('click', hideGuide);
    document.body.appendChild(guide);
  }
  function hideGuide() { clearTimeout(guideTimer); if (guide) guide.classList.remove('on'); }
  function speak() {
    if (!guide) buildGuide();
    var roll = Math.random(), who = 'guide';
    if (roll < CHROMESBY_ODDS) who = 'chromesby';
    else if (roll < CHROMESBY_ODDS + HATGUY_ODDS) who = 'hatguy';
    else if (roll < CHROMESBY_ODDS + HATGUY_ODDS + BROTHER_ODDS) who = 'brother';
    var peeking = who === 'hatguy' && Math.random() < PEEK_ODDS;
    guide.classList.remove('on', 'shock');
    ['chromesby', 'hatguy', 'brother'].forEach(function (c) { guide.classList.toggle(c, who === c); });
    guide.classList.toggle('peeking', peeking);
    guide.querySelector('img.who').src = 'img/' + who + '.webp';
    if (peeking) guide.querySelector('img.peek').src = 'img/brother.webp';
    guide.querySelector('b').textContent = who === 'chromesby' ? 'Chromesby' : (who === 'brother' ? 'whispering' : '');
    guide.querySelector('span').textContent = who === 'chromesby' ? nextChrome() : (who === 'hatguy' ? nextHatguy() : (who === 'brother' ? nextBrother() : nextLine()));
    void guide.offsetWidth;
    guide.classList.add('on');
    clearTimeout(guideTimer);
    guideTimer = setTimeout(hideGuide, who === 'guide' ? 4200 : (who === 'brother' ? 6000 : 5200));
  }
  // Very rarely, when the reader scrolls to a card with a top score of 99 and stays on it for a second,
  // a shocked Chromesby pops up.
  var SHOCK_ODDS = 1 / 10, SHOCK_REST = 60000;
  var topWatch = null, topTimers = [], scrolled = false, lastShock = 0;
  function shock() {
    if (!guide) buildGuide();
    guide.classList.remove('on', 'hatguy', 'brother', 'peeking');
    guide.classList.add('chromesby', 'shock');
    guide.querySelector('img.who').src = 'img/chromesby-shock.webp';
    guide.querySelector('b').textContent = 'Chromesby';
    guide.querySelector('span').textContent = 'Holy Shit!';
    void guide.offsetWidth;
    guide.classList.add('on');
    clearTimeout(guideTimer);
    guideTimer = setTimeout(hideGuide, 3200);
    lastShock = Date.now();
  }
  function watchTopScores() {
    if (topWatch) topWatch.disconnect();
    topTimers.forEach(clearTimeout);
    topTimers = [];
    scrolled = false;
    var targets = screen.querySelectorAll('[data-top-score]');
    if (!targets.length || !('IntersectionObserver' in window)) return;
    new Image().src = 'img/chromesby-shock.webp';
    topWatch = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var el = entry.target;
        clearTimeout(el._dwell);
        if (!entry.isIntersecting) return;
        el._dwell = setTimeout(function () {
          // Only after a scroll, only if nothing else is talking, and not again for a while.
          if (!scrolled || (guide && guide.classList.contains('on')) || Date.now() - lastShock < SHOCK_REST) return;
          if (Math.random() < SHOCK_ODDS) shock();
        }, 1000);
        topTimers.push(el._dwell);
      });
    }, { threshold: 0.95 });
    targets.forEach(function (el) { topWatch.observe(el); });
  }
  window.addEventListener('scroll', function () { scrolled = true; }, { passive: true });

  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    if (e.target.closest('#strategy')) { speak(); return; }
    var toggle = e.target.closest('.var-btn');
    if (toggle) {
      var panel = document.getElementById('variants'), open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (panel) panel.hidden = !open;
      return;
    }
    var card = e.target.closest('.var');
    if (card) card.setAttribute('aria-pressed', card.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  });

  window.addEventListener('hashchange', function () { hideGuide(); route(); });
  route();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
