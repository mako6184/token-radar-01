// Token Launch Radar — dashboard for model "radar-2".
// Reads window.RADAR (written beside dashboard/ by main.ts) and renders: the ranked board with
// search, category / chain / verdict filters and sortable columns; a detail view per protocol
// with the valuation's working, the launch propensity and the farm plan; a Live tokens view of
// the protocols that already trade (the peer set, at market values); and a Model view that
// states the formulas and their held-out validation. No network: every byte is in data.js.
// Routes live in the hash so any view can be linked or screenshotted:
//   #/  the board        #/?cat=Lending&watch=1  a filtered board
//   #/p/<slug>  a protocol's detail        #/live  live tokens        #/model  the model
(function () {
  'use strict';

  var DATA = window.RADAR;
  var app = document.getElementById('board');
  if (!DATA || !app) return;

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function chipClass(v) { return v.toLowerCase().replace(' ', '-'); }

  var bySlug = {};
  DATA.rows.forEach(function (r) { bySlug[r.slug] = r; });
  var categories = [];
  var chains = [];
  DATA.rows.forEach(function (r) {
    if (r.category && categories.indexOf(r.category) < 0) categories.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  categories.sort();
  chains.sort();

  function parseRoute() {
    var h = location.hash.replace(/^#/, '') || '/';
    var qAt = h.indexOf('?');
    var path = qAt >= 0 ? h.slice(0, qAt) : h;
    var params = {};
    if (qAt >= 0) {
      h.slice(qAt + 1).split('&').forEach(function (kv) {
        var p = kv.split('=');
        if (p.length === 2) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1]);
      });
    }
    return { path: path, params: params };
  }

  function boardHref(params) {
    var parts = [];
    Object.keys(params).forEach(function (k) { if (params[k]) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k])); });
    return '#/' + (parts.length ? '?' + parts.join('&') : '');
  }

  function header(active) {
    var v = DATA.validation, ov = DATA.odds_validation;
    var tabs = [['board', '#/', 'Board'], ['live', '#/live', 'Live tokens'], ['model', '#/model', 'Model & validation']]
      .map(function (t) { return '<a href="' + t[1] + '"' + (active === t[0] ? ' class="on"' : '') + '>' + t[2] + '</a>'; }).join('');
    return '' +
      '<div class="masthead"><h1>Token Launch Radar <span class="dot">●</span></h1>' +
      '<span class="sub">Pre-token protocols ranked by implied launch value — model ' + esc(DATA.model_version) + ', snapshot of ' + esc(DATA.as_of) + '</span>' +
      '<span class="badge">source: <b>DefiLlama</b></span></div>' +
      '<div class="stats">' +
      '<div class="stat"><div class="k">Protocols scanned</div><div class="v">' + DATA.census_size + '</div><div class="n">every protocol in the snapshot</div></div>' +
      '<div class="stat"><div class="k">Record no token</div><div class="v">' + DATA.pre_token_size + '</div><div class="n">no market cap, no CoinGecko id, no symbol</div></div>' +
      '<div class="stat"><div class="k">Watchlist covered</div><div class="v">' + DATA.watchlist_size + ' / ' + DATA.watchlist_size + '</div><div class="n">TVL at or above ' + fmtUsd(DATA.floor_usd) + ', not a wrapped or staked product</div></div>' +
      '<div class="stat"><div class="k">Ranked on the board</div><div class="v">' + DATA.board_size + '</div><div class="n">the watchlist plus the early radar below the floor</div></div>' +
      '<div class="stat"><div class="k">Peer model error</div><div class="v">×' + v.fold_error + '</div><div class="n">median held-out error on ' + v.peer_count + ' tokenised peers, 5-fold</div></div>' +
      '<div class="stat"><div class="k">Launch odds Brier</div><div class="v">' + ov.brier_cv + '</div><div class="n">vs ' + ov.brier_base_rate + ' for guessing the base rate</div></div>' +
      '</div>' +
      '<div class="tabs">' + tabs + '</div>';
  }

  function footer() {
    return '<footer><b>How to read this board.</b> Implied value is this entry\u2019s model claim — what a token ' +
      'would be worth if the protocol\u2019s record stayed as it is — never a prediction that a token will exist. ' +
      'Launch propensity is cross-sectional: of the protocols in the snapshot that look like this one, the share ' +
      'that already carry a token. Farm plans are generated from each protocol\u2019s category, chain, TVL and age; ' +
      'capital in a plan is recoverable and is never counted as a cost. Data: ' + esc(DATA.source) + '.</footer>';
  }

  /* ------------------------------------------------ board */
  function renderBoard(params) {
    var state = {
      q: params.q || '', cat: params.cat || 'all', chain: params.chain || 'all',
      watch: params.watch === '1', verdict: params.verdict || 'all',
      sort: params.sort || 'implied', dir: params.dir === '1' ? 1 : -1,
    };
    var rows = DATA.rows.filter(function (r) {
      if (state.watch && !r.on_watchlist) return false;
      if (state.cat !== 'all' && r.category !== state.cat) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
      if (state.q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(state.q.toLowerCase()) < 0) return false;
      return true;
    });
    var key = { implied: 'implied_value_usd', tvl: 'tvl_usd', change: 'change_7d', age: 'age_days', odds: 'launch_odds', cost: 'season_cost_usd', rank: 'rank' }[state.sort] || 'implied_value_usd';
    rows.sort(function (a, b) {
      var av = a[key], bv = b[key];
      if (av === null || av === undefined) av = -Infinity;
      if (bv === null || bv === undefined) bv = -Infinity;
      return (av - bv) * state.dir || a.rank - b.rank;
    });

    function opts(list, cur, allLabel) {
      return '<option value="all">' + allLabel + '</option>' + list.map(function (c) {
        return '<option value="' + esc(c) + '"' + (c === cur ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('');
    }
    var verdicts = ['Farm first', 'Farm cheap', 'Watch', 'Skip'];
    var controls =
      '<div class="controls">' +
      '<input type="search" id="f-q" placeholder="Search name, slug, category…" value="' + esc(state.q) + '">' +
      '<select id="f-cat">' + opts(categories, state.cat, 'All categories') + '</select>' +
      '<select id="f-chain">' + opts(chains, state.chain, 'All chains') + '</select>' +
      '<select id="f-verdict">' + opts(verdicts, state.verdict, 'All verdicts') + '</select>' +
      '<label class="chk"><input type="checkbox" id="f-watch"' + (state.watch ? ' checked' : '') + '> Watchlist only</label>' +
      '<span class="count">' + rows.length + ' of ' + DATA.board_size + ' protocols</span></div>';

    var cols = [
      ['rank', '#', ''], ['name', 'Protocol', ''], ['tvl', 'TVL', 'num'], ['change', '7d', 'num'],
      ['age', 'Age', 'num'], ['implied', 'Implied value', 'num'], ['odds', 'Launch odds', 'num'], ['cost', 'Season cost', 'num'], ['verdict', 'Verdict', ''],
    ];
    var thead = '<tr>' + cols.map(function (c) {
      var arrow = state.sort === c[0] ? (state.dir === -1 ? ' ▾' : ' ▴') : '';
      return '<th class="' + c[2] + '" data-sort="' + c[0] + '">' + c[1] + arrow + '</th>';
    }).join('') + '</tr>';

    var body = rows.map(function (r) {
      var tags = (r.on_watchlist ? '<span class="tag">watchlist</span>' : '');
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + tags + '<br><span class="pcat">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.slice(0, 3).join(', ') || '—') + '</span></td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td class="num implied">' + fmtUsd(r.implied_value_usd) + '</td>' +
        '<td class="num"><span class="oddsbar"><i style="width:' + Math.round(r.launch_odds * 100) + '%"></i></span>' + Math.round(r.launch_odds * 100) + '%</td>' +
        '<td class="num">' + fmtUsd(r.season_cost_usd) + '</td>' +
        '<td><span class="chip ' + chipClass(r.verdict) + '">' + esc(r.verdict) + '</span></td></tr>';
    }).join('');

    app.innerHTML = header('board') +
      '<div class="modelstrip">The model in one line: each protocol is priced off its <b>' + DATA.fit.comp_count + ' nearest tokenised ' +
      'peers</b> (by TVL, same category preferred) — the weighted geometric mean of their market-cap/TVL multiples — ' +
      'then seven-day growth and maturity adjustments. Held out on the peers themselves, its median error is ' +
      '<b>×' + DATA.validation.fold_error + '</b>. <a href="#/model">Full model &amp; validation</a></div>' +
      controls + '<table><thead>' + thead + '</thead><tbody>' + body + '</tbody></table>' + footer();
    app.setAttribute('aria-busy', 'false');
    wireBoard(state);
  }

  function wireBoard(state) {
    function go(patch) {
      var next = Object.assign({}, state, patch);
      location.hash = boardHref({
        q: next.q, cat: next.cat === 'all' ? '' : next.cat, chain: next.chain === 'all' ? '' : next.chain,
        watch: next.watch ? '1' : '', verdict: next.verdict === 'all' ? '' : next.verdict,
        sort: next.sort === 'implied' ? '' : next.sort, dir: next.dir === 1 ? '1' : '',
      }).slice(1);
    }
    var q = document.getElementById('f-q');
    q.addEventListener('change', function () { go({ q: q.value }); });
    document.getElementById('f-cat').addEventListener('change', function (e) { go({ cat: e.target.value }); });
    document.getElementById('f-chain').addEventListener('change', function (e) { go({ chain: e.target.value }); });
    document.getElementById('f-verdict').addEventListener('change', function (e) { go({ verdict: e.target.value }); });
    document.getElementById('f-watch').addEventListener('change', function (e) { go({ watch: e.target.checked }); });
    Array.prototype.forEach.call(app.querySelectorAll('th[data-sort]'), function (th) {
      th.addEventListener('click', function () {
        var s = th.getAttribute('data-sort');
        go({ sort: s, dir: state.sort === s ? -state.dir : (s === 'rank' || s === 'cost' ? 1 : -1) });
      });
    });
    Array.prototype.forEach.call(app.querySelectorAll('tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () { location.hash = '/p/' + tr.getAttribute('data-slug'); });
    });
  }

  /* ------------------------------------------------ detail */
  function splitStep(s) {
    var ci = s.indexOf('. Cost: ');
    var ti = s.lastIndexOf('. Time: ');
    if (ci < 0 || ti < 0 || ti < ci) return { text: s, cost: '', time: '' };
    return {
      text: s.slice(0, ci) + '.',
      cost: s.slice(ci + 8, ti),
      time: s.slice(ti + 8).replace(/\.$/, ''),
    };
  }

  function renderDetail(slug) {
    var r = bySlug[slug];
    if (!r) { renderBoard({}); return; }
    var m = r.model;
    var steps = r.farm_steps.map(function (s) {
      var p = splitStep(s);
      return '<li><div>' + esc(p.text) + '</div><div class="meta">Cost: <b>' + esc(p.cost) + '</b> · Time: <b>' + esc(p.time) + '</b></div></li>';
    }).join('');
    var flags = (r.on_watchlist ? '<span class="tag">on the house watchlist</span>' : '<span class="tag">early radar — below the watchlist floor</span>');
    app.innerHTML = header('board') +
      '<a class="back" href="#/">← Back to the board</a>' +
      '<div class="detail-head"><h2>' + esc(r.name) + '</h2><span class="chip ' + chipClass(r.verdict) + '">' + esc(r.verdict) + '</span>' + flags + '</div>' +
      '<p class="note">Rank #' + r.rank + ' of ' + DATA.board_size + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ') || 'no chain listed') +
      ' · records no token in the snapshot (no market cap, no CoinGecko id, no symbol).</p>' +
      '<div class="grid">' +
      '<div class="card"><h3>The record</h3>' +
      kv('TVL', fmtUsd(r.tvl_usd)) + kv('TVL change, 7 days', fmtPct(r.change_7d)) +
      kv('Tracked since', r.listed_at ? esc(r.listed_at) + ' (' + fmtAge(r.age_days) + ')' : 'not reported') +
      kv('Chains', esc(r.chains.join(', ') || '—')) + kv('Category', esc(r.category || '—')) + '</div>' +
      '<div class="card"><h3>Implied value — the working</h3>' +
      kv('Comp multiple (× TVL)', '×' + m.comp_multiple + ' from ' + m.comp_count + ' nearest peers') +
      kv('Peer base (TVL × multiple)', fmtUsd(m.peer_base_usd)) +
      kv('Growth adjustment', '×' + m.growth_multiplier + ' (' + fmtPct(m.growth_pct) + ' in 7d, clamped)') +
      kv('Maturity adjustment', '×' + m.maturity_multiplier + ' (age ' + fmtAge(m.age_days) + ')') +
      kv('Implied value', fmtUsd(r.implied_value_usd)) +
      kv('Comp range (quartiles)', fmtUsd(m.implied_low_usd) + ' – ' + fmtUsd(m.implied_high_usd)) +
      '<p class="note">The comps are the ' + m.comp_count + ' tokenised protocols nearest this one in TVL (same category ' +
      'preferred), out of ' + DATA.fit.peer_count + ' usable peers in this snapshot. Held out, the estimator\u2019s median ' +
      'error is ×' + DATA.validation.fold_error + ' — treat the implied value as the middle of the comp range, not a point forecast.</p></div>' +
      '<div class="card"><h3>Launch propensity</h3>' +
      '<div class="oddsbig">' + Math.round(r.launch_odds * 100) + '%</div>' +
      '<p class="note">Of the ' + DATA.odds_validation.census + ' protocols in the census, ' + DATA.odds_validation.tokenised + ' already carry a token. ' +
      'A logistic fit on size and age — cross-validated Brier ' + DATA.odds_validation.brier_cv + ' against ' + DATA.odds_validation.brier_base_rate +
      ' for the base rate — puts a protocol with this record at ' + Math.round(r.launch_odds * 100) + '%. It is a statement about ' +
      'look-alikes in this snapshot, not a dated prediction.</p>' +
      kv('Season verdict', r.verdict) + kv('Cash cost of one season', fmtUsd(r.season_cost_usd)) + '</div>' +
      '</div>' +
      '<div class="card" style="margin-top:12px"><h3>Farm plan — ' + r.farm_steps.length + ' steps, about ' + fmtUsd(r.season_cost_usd) + ' of cash costs</h3>' +
      '<ol class="steps">' + steps + '</ol>' +
      '<p class="note">Capital in the steps is recoverable and is not counted in the season cost; the cost is gas and fees only. ' +
      'Never pay a fee to claim a reward, and only ever follow links from the protocol\u2019s official site.</p></div>' +
      footer();
    app.setAttribute('aria-busy', 'false');
    window.scrollTo(0, 0);
  }
  function kv(k, v) { return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }

  /* ------------------------------------------------ live */
  function renderLive() {
    var body = DATA.live.map(function (r, i) {
      return '<tr><td class="rank">' + (i + 1) + '</td><td><span class="pname">' + esc(r.name) + '</span><br><span class="pcat">' +
        esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.slice(0, 3).join(', ')) + '</span></td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td><td class="num implied">' + fmtUsd(r.mcap_usd) + '</td>' +
        '<td class="num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(r.change_7d) + '</td></tr>';
    }).join('');
    app.innerHTML = header('live') +
      '<p class="note">These protocols already have a token: the board never ranks them. They are the peer set the ' +
      'valuation line is fitted on, shown at the market\u2019s own values. The ' + DATA.fit.peer_count + ' peers with a market ' +
      'cap anchor the model; the largest ' + DATA.live.length + ' are listed here.</p>' +
      '<table><thead><tr><th>#</th><th>Protocol</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">7d</th></tr></thead><tbody>' + body + '</tbody></table>' + footer();
    app.setAttribute('aria-busy', 'false');
  }

  /* ------------------------------------------------ model */
  function renderModel() {
    var v = DATA.validation, ov = DATA.odds_validation;
    app.innerHTML = header('model') +
      '<div class="grid"><div class="card"><h3>Implied value</h3>' +
      '<p class="note">Market cap per TVL dollar is dispersed across DeFi — in this snapshot the middle 80% of tokenised ' +
      'peers span a factor of 230 — so the model prices by comparable peers, not by one multiple. For each protocol it takes ' +
      'the ' + DATA.fit.comp_count + ' peers nearest in log₁₀ TVL (distance halved when the category matches), winsorises their ' +
      'market-cap/TVL multiples to the peer set\u2019s 5th–95th percentile, and applies the kernel-weighted geometric mean. ' +
      'Growth (seven-day TVL change, clamped to −60%…+120%, weight 0.5) and maturity (0.6 + 0.4 × age/3y, unknown age read ' +
      'as one year) adjust the base. Peers with a zero recorded market cap price nothing and are excluded (' + v.peer_count +
      ' of the tokenised protocols remain). No name is special-cased: one function prices every row, and each row shows ' +
      'its comp range beside the point value.</p>' +
      kv('Held-out median error', '×' + v.fold_error) +
      kv('Held-out peers priced within ×2', Math.round(v.within_2x_share * 100) + '%') +
      kv('Held-out peers priced within ×3', Math.round(v.within_3x_share * 100) + '%') +
      kv('Validation', v.folds + '-fold cross-validation, folds by slug hash') + '</div>' +
      '<div class="card"><h3>Launch propensity</h3>' +
      '<p class="note">The outcome is known for all ' + ov.census + ' protocols in the census: ' + ov.tokenised + ' carry a token, ' +
      (ov.census - ov.tokenised) + ' record none. A logistic regression on standardised log₁₀ TVL and age is fitted to that ' +
      'outcome; a pre-token protocol\u2019s score is the fitted share of look-alikes that already carry a token. It separates ' +
      'the board\u2019s rows from the merely large: size alone is not a launch signal, and the fit says how much of it is.</p>' +
      kv('Cross-validated Brier score', String(ov.brier_cv)) +
      kv('Base-rate Brier score', String(ov.brier_base_rate)) +
      kv('Census token rate', Math.round((ov.tokenised / ov.census) * 100) + '%') + '</div>' +
      '<div class="card"><h3>Coverage &amp; the gate\u2019s shape</h3>' +
      '<p class="note">The board ranks all ' + DATA.board_size + ' rankable pre-token protocols in the snapshot — every one of the ' +
      DATA.watchlist_size + ' watchlist protocols (TVL ≥ ' + fmtUsd(DATA.floor_usd) + ', no token recorded, not a wrapped, staked or ' +
      'bridged product) plus the early radar below the floor. The same product rule is applied at every size: wrapped, staked ' +
      'and bridged products of tokens that already trade (WBTC, exchange staking products, canonical bridges), exchanges and ' +
      'versioned pools of other protocols are set aside, never ranked — a product of a traded token is not a launch candidate.</p>' +
      kv('Board rows', String(DATA.board_size)) + kv('Watchlist coverage', DATA.watchlist_size + ' / ' + DATA.watchlist_size) +
      kv('Products of traded tokens set aside', String(DATA.products_set_aside)) +
      kv('Live peers set aside', String(DATA.live_size) + ' shown, ' + v.peer_count + ' fitted') + '</div></div>' + footer();
    app.setAttribute('aria-busy', 'false');
  }

  function render() {
    var route = parseRoute();
    if (route.path.indexOf('/p/') === 0) renderDetail(decodeURIComponent(route.path.slice(3)));
    else if (route.path === '/live') renderLive();
    else if (route.path === '/model') renderModel();
    else renderBoard(route.params);
  }
  window.addEventListener('hashchange', render);
  render();
})();
