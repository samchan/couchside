(() => {
  const app = $('#app');
  const qs = new URLSearchParams(location.search);
  const PRINT = qs.get('print') === '1';
  let token = store.get('ap_admin');
  let S = null;
  let skew = 0;
  let lastKey = '';
  let qrCache = { code: null, svg: null };

  // Optional photos (Admin -> Settings -> Photos: https image links). None set = no photo frames.
  const photos = () => (CFG.photos || []);
  const POSTER_PHOTO = Number(qs.get('photo')) || 0;
  let photoTimer;
  function photo(w, hgt, tilt) {
    const list = photos();
    if (!list.length) return null;
    let n = Math.floor(Math.random() * list.length);
    const img = h('img', { src: list[n], alt: '', style: 'width:100%;height:100%;object-fit:cover;display:block;transition:opacity .6s' });
    img.onerror = () => { img.style.visibility = 'hidden'; };
    const box = h('div', { style: `width:${w}px;height:${hgt}px;background:#fff;padding:10px 10px 34px;border:3px solid var(--ink);border-radius:8px;box-shadow:6px 6px 0 var(--ink);transform:rotate(${tilt || -3}deg);flex:none` }, img);
    clearInterval(photoTimer);
    if (list.length > 1) photoTimer = setInterval(() => {
      n = (n + 1 + Math.floor(Math.random() * Math.min(6, list.length - 1))) % list.length;
      img.style.opacity = 0;
      setTimeout(() => { img.src = list[n]; img.style.visibility = ''; img.style.opacity = 1; }, 600);
    }, 6000);
    return box;
  }

  const joinUrl = () => `${location.origin}/play?c=${encodeURIComponent(S.join_code)}`;

  function qrNode(size) {
    if (qrCache.code !== S.join_code) {
      const q = qrcode(0, 'M');
      q.addData(joinUrl());
      q.make();
      qrCache = { code: S.join_code, svg: q.createSvgTag({ cellSize: 8, margin: 2, scalable: true }) };
    }
    const box = h('div', { class: 'tv-qr' });
    const inner = document.createElement('div');
    inner.style.width = size + 'px';
    inner.style.height = size + 'px';
    inner.innerHTML = qrCache.svg; // generated locally from our own URL
    const svg = inner.querySelector('svg');
    if (svg) { svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%'); }
    box.append(inner);
    return box;
  }

  // Polls with ?v=<key>: the server replies {same:true} (2 row reads) unless the game moved
  // or a guest did something, so a TV left open all day costs almost nothing.
  async function load(force) {
    if (!token) { if (!app.querySelector('input')) render(true); return; }
    try {
      const v = !force && S && S.key ? '?v=' + encodeURIComponent(S.key) : '';
      const st = await call('/api/admin/tv' + v, { headers: { 'x-admin': token } });
      if (st.same) return;
      skew = st.server_now - Date.now();
      S = st;
      applyCfg(S.cfg, PRINT ? 'poster' : 'TV');
      render();
    } catch (e) {
      if (e.status === 401) { token = null; store.del('ap_admin'); S = null; render(true); demoLogin().then((t) => { if (t) { token = t; load(true); } }); }
    }
  }

  function loginView() {
    const pin = h('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'Admin PIN' });
    const go = async () => {
      try { const r = await call('/api/admin/login', { body: { pin: pin.value } }); token = r.token; store.set('ap_admin', token); load(); }
      catch (e) { toast(e.message, true); }
    };
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return h('div', { class: 'wrap', style: 'padding-top:10vh' }, h('div', { class: 'hero' }, mascot('bob'), h('h1', null, 'TV ', h('em', null, 'screen'))),
      h('div', { class: 'card stack' }, pin, h('button', { class: 'btn block', onclick: go }, 'Start')));
  }

  function title() {
    return h('div', { class: 'row', style: 'gap:16px' }, mascot('bob'), h('h1', { class: 'tv-title', style: 'margin:0' }, fancyTitle(CFG.subtitle || CFG.title)));
  }

  function side() {
    const lb = S.leaderboard;
    if (!lb) {
      return h('div', { class: 'tv-side' },
        h('div', { class: 'card center' }, h('div', { class: 'small muted' }, 'Scan to play'), qrNode(300),
          CFG.closes_text ? h('div', { class: 'small muted', style: 'margin-top:8px' }, CFG.closes_text) : null));
    }
    return h('div', { class: 'tv-side' },
      h('div', { class: 'card', style: 'flex:1;overflow:hidden' }, h('h2', null, 'Top ', h('em', null, 'players')),
        h('ol', { class: 'lb' }, lb.slice(0, 10).map((r) => h('li', null, h('span', { class: 'rk' }, r.rank), h('span', { class: 'nm' }, r.name), h('span', { class: 'sc' }, r.score))))),
      S.phase === 'reveal' || S.phase === 'final' ? h('div', { class: 'card center', style: 'padding:12px' }, h('div', { class: 'small muted' }, 'Late? Scan to join'), qrNode(150)) : null);
  }

  function answerMain() {
    const P = S.players;
    const done = P.filter((p) => p.done_answering).length;
    return h('div', { class: 'tv-main' }, title(),
      h('div', { class: 'tv-q' }, 'Scan the code to play.' + (CFG.closes_text ? ' ' + CFG.closes_text + '.' : '')),
      h('div', { class: 'row', style: 'gap:30px;align-items:flex-start;flex-wrap:nowrap' },
        qrNode(Math.min(420, window.innerHeight * 0.45)),
        photo(260, 290, -3),
        h('div', { style: 'flex:1;min-width:0' },
          h('div', { style: 'font-size:2rem;font-weight:800;margin-bottom:6px' }, `${P.length} playing · ${done} done`),
          h('div', { class: 'tv-names', style: 'max-height:50vh' }, P.map((p) => h('span', { class: 'pill ' + (p.done_answering ? 'yellow' : '') }, (p.done_answering ? '✓ ' : '') + p.name))))));
  }

  function voteMain() {
    return h('div', { class: 'tv-main', style: 'justify-content:center' }, title(),
      h('div', { class: 'tv-q' }, 'Answers are locked! Gather round the TV.'),
      h('div', { style: 'font-size:1.8rem;line-height:1.4;margin-bottom:24px' },
        'Keep your phone open on the game page. Each question pops up here and on your phone. ',
        h('strong', null, 'Vote on your phone'), ' before the timer runs out.'),
      h('div', { class: 'row', style: 'gap:30px;align-items:center;flex-wrap:nowrap' },
        photo(280, 300, -4),
        qrNode(Math.min(240, window.innerHeight * 0.28)),
        h('div', { style: 'font-size:1.4rem' }, h('div', { style: 'font-weight:800' }, `${S.players.length} players ready`),
          h('div', { class: 'muted' }, 'Lost the page? Scan to get back in.'))));
  }

  function revealMain() {
    const sl = S.slide;
    if (!sl) return h('div', { class: 'tv-main' }, title());
    if (sl.step === 0) return liveMain(sl);
    if (sl.step === 1) return showcase(sl);
    return leaderboardMain(sl);
  }

  // Step 1: the most-voted answer and who wrote it, then (guess-the-host rounds) a drumroll
  // and the host's answer, then the full list. Runs on its own clock so a refresh resumes it.
  const animStart = {};
  let animTimer;
  function showcase(sl) {
    const key = `${sl.idx}:1`;
    if (!animStart[key]) animStart[key] = Date.now();
    const isText = sl.prompt.kind === 'text' || sl.prompt.kind === 'funny'; // write-in rounds (both kinds)
    const funny = sl.prompt.kind === 'funny';
    const allVoted = isText ? sl.options.filter((o) => o.count > 0) : [];
    const voted = allVoted.slice(0, 1);          // the most-voted answer gets its own moment
    const rest = [];                             // everything else is listed at the end
    // each answer: first the answer + its votes, then who wrote it
    const quick = false;
    const topIsHost = !!(voted[0] && voted[0].hosts); // the crowd found the real answer: skip the drumroll
    const A_MS = quick ? 2000 : 2400, W_MS = quick ? 1800 : 2600, PER = A_MS + W_MS, ROLL = topIsHost || funny ? 0 : 2600, total = voted.length * PER;
    const wrap = h('div', { class: 'tv-main' });
    const head = () => [
      h('div', { class: 'row between' }, h('span', { class: 'pill yellow', style: 'font-size:1.2rem' }, `Question ${sl.idx + 1} of ${sl.total}`),
        h('span', { class: 'muted', style: 'font-size:1.2rem' }, isText ? 'Your answers' : 'How everyone answered')),
      h('div', { class: 'tv-q', style: 'margin-bottom:14px' }, sl.prompt.text)];
    const byLine = (o) => o.authors && o.authors.length ? `written by ${o.authors.join(', ')}` : '';
    const smallBar = (o, showMatch) => h('div', { class: 'bar' + (showMatch ? (o.is_match ? ' match' : ' dim') : ''), style: 'min-height:52px' },
      h('i', { style: `width:${Math.round(((o.count || 0) / Math.max(1, ...sl.options.map((x) => x.count || 0))) * 100)}%` }),
      h('span', { style: 'font-size:1.35rem' }, (showMatch && o.is_match ? '✓ ' : '') + o.label,
        isText && o.authors ? h('span', { class: 'muted', style: 'font-size:1rem;font-weight:600;margin-left:10px' }, o.authors.join(', ')) : null),
      h('b', { style: 'font-size:1.4rem' }, o.count || 0));
    let last = null;
    const draw = () => {
      const t = Date.now() - animStart[key];
      const stage = t < total ? (t % PER < A_MS ? 'a' : 'w') + Math.floor(t / PER) : t < total + ROLL ? 'roll' : 'done';
      if (stage === last) return;
      const resumed = last === null && t > 600;
      last = stage;
      if (!resumed) {
        if (stage[0] === 'a') Sound.pop();
        else if (stage[0] === 'w') Sound.tick(false);
        else if (stage === 'roll') Sound.drumroll(ROLL / 1000);
        else Sound.fanfare();
      }
      let body;
      if (stage[0] === 'a' || stage[0] === 'w') {
        const i = Number(stage.slice(1)), o = voted[i];
        const who = stage[0] === 'w';
        body = [
          h('div', { class: 'reveal-banner', style: 'margin-top:0;font-size:3rem;text-align:center;padding:26px' }, o.label,
            h('div', { style: 'font-family:var(--sans);font-size:1.6rem;margin-top:10px' }, `${o.count} vote${o.count === 1 ? '' : 's'}`),
            who && o.hosts ? h('div', { style: 'font-family:var(--serif);font-size:2.2rem;margin-top:12px;animation:pop .4s ease' }, `${HostName()}! \ud83c\udf89`,
                h('div', { style: 'font-family:var(--sans);font-size:1.3rem;margin-top:6px' }, 'That\u2019s the real answer'))
            : who ? h('div', { style: 'font-family:var(--serif);font-size:2.2rem;margin-top:12px;animation:pop .4s ease' }, (o.authors || []).join(' & ') || '?')
              : h('div', { style: 'font-family:var(--sans);font-size:1.3rem;margin-top:12px;opacity:.7' }, 'Who wrote it\u2026?')),
          h('div', { class: 'bars', style: 'margin-top:18px' }, voted.slice(0, i).map((x) => smallBar(x, false))),
          h('div', { class: 'muted', style: 'font-size:1.1rem;margin-top:10px' }, funny ? 'Crowd favourite' : 'Most voted answer')];
      } else if (!isText) {
        // Multiple choice: one screen. Options stay put; drumroll underneath; then counts + the right one light up.
        const done = stage === 'done';
        const max = Math.max(1, ...sl.options.map((x) => x.count || 0));
        const mcRow = (o) => h('div', { class: 'bar' + (done ? (o.is_match ? ' match' : ' dim') : ''), style: 'min-height:58px' },
          h('i', { style: `width:${done ? Math.round(((o.count || 0) / max) * 100) : 0}%` }),
          h('span', { style: 'font-size:1.5rem' }, h('b', { style: 'display:inline-block;width:46px;padding:0;font-family:var(--serif);color:var(--pop)' }, o.letter), (done && o.is_match ? '\u2713 ' : '') + o.label),
          h('b', { style: 'font-size:1.5rem' }, done ? `${o.count || 0}` : ''));
        body = [h('div', { class: 'bars' }, sl.options.map(mcRow)),
          done
            ? h('div', { class: 'reveal-banner' }, `${HostName()} says: `, h('strong', null, sl.host_answer || '?'))
            : h('div', { class: 'reveal-banner', style: 'background:var(--card);animation:none' }, hostLine(sl.idx))];
        if (done) clearInterval(animTimer);
      } else if (stage === 'roll') {
        body = [h('div', { class: 'center', style: 'font-family:var(--serif);font-size:clamp(2rem,5vw,3.6rem);margin:30px 0' }, hostLine(sl.idx)),
          isText ? null : h('div', { class: 'bars' }, sl.options.slice(0, 7).map((x) => smallBar(x, false))),
          rest.length ? h('div', { class: 'muted', style: 'font-size:1.15rem;margin-top:12px' }, 'Also voted for: ' + rest.map((o) => `${o.label} (${(o.authors || []).join(', ')})`).join(' · ')) : null];
      } else {
        const all = sl.options.slice(0, 16);
        const compact = all.length > 8;
        const winners = sl.options.filter((o) => o.is_match && !o.hosts).flatMap((o) => o.authors || []);
        const fav = funny && sl.options[0] && sl.options[0].count ? sl.options[0] : null;
        const listRow = (o, i) => h('div', { class: 'bar' + (o.is_match ? ' match' : ''), style: `min-height:${compact ? 40 : 52}px;animation:pop .35s ease both;animation-delay:${0.25 + i * 0.12}s` },
          h('i', { style: `width:${Math.round(((o.count || 0) / Math.max(1, ...sl.options.map((x) => x.count || 0))) * 100)}%` }),
          h('span', { style: `font-size:${compact ? 1.05 : 1.35}rem;padding:4px 14px` }, (o.is_match ? '\u2713 ' : '') + o.label,
            isText && o.authors ? h('span', { class: 'muted', style: `font-size:${compact ? 0.9 : 1}rem;font-weight:600;margin-left:10px` }, o.authors.join(', ')) : null),
          h('b', { style: `font-size:${compact ? 1.1 : 1.4}rem;padding:0 14px` }, `${o.count || 0}`));
        body = [
          funny
            ? h('div', { class: 'reveal-banner', style: 'margin:0 0 12px' }, fav ? ['Crowd favourite: ', h('strong', null, fav.label),
              h('div', { style: 'font-family:var(--sans);font-size:1.2rem;margin-top:8px' }, `by ${(fav.authors || []).join(' & ')}`)] : 'Nobody voted!')
            : h('div', { class: 'reveal-banner', style: 'margin:0 0 12px' }, `${HostName()} says: `, h('strong', null, sl.host_answer || '?'),
              winners.length ? h('div', { style: 'font-family:var(--sans);font-size:1.2rem;margin-top:8px' }, `Nailed it: ${winners.join(', ')}`) : null),
          h('div', { class: 'bars', style: `gap:${compact ? 6 : 10}px` }, all.map(listRow))];
        clearInterval(animTimer);
      }
      wrap.replaceChildren(...[...head(), ...body].filter(Boolean));
    };
    clearInterval(animTimer);
    animTimer = setInterval(draw, 150);
    draw();
    return wrap;
  }

  // Step 2: leaderboard. Rows start in last round's order, then slide to the new
  // order while scores count up, with arrows for who climbed or dropped.
  function leaderboardMain(sl) {
    const key = `${sl.idx}:2`;
    if (!animStart[key]) animStart[key] = Date.now();
    const lb = S.leaderboard || [];
    const res = new Map((sl.results || []).map((r) => [r.name, r]));
    const rows = lb.map((r) => ({ ...r, gain: res.has(r.name) ? res.get(r.name).pts : 0, chip: res.has(r.name) ? res.get(r.name).chip : null }));
    rows.forEach((r) => { r.prev = r.score - r.gain; });
    const prevOrder = [...rows].sort((a, b) => b.prev - a.prev || a.name.localeCompare(b.name));
    prevOrder.forEach((r, i) => { r.prevPos = i; });
    rows.forEach((r, i) => { r.pos = i; });
    // everyone fits: one column up to 12 players, two columns up to 26
    const SHOW = Math.min(rows.length, 26);
    const cols = SHOW > 12 ? 2 : 1, perCol = Math.ceil(SHOW / cols);
    const ROW = cols === 2 ? Math.min(58, Math.floor((window.innerHeight - 300) / perCol)) : 62;
    const big = cols === 1;
    const place = (pos) => {
      const p = Math.min(pos, SHOW - 1 + 1);
      const c = Math.min(cols - 1, Math.floor(p / perCol));
      return { top: (p - c * perCol) * ROW, left: c ? 'calc(50% + 8px)' : '0px' };
    };
    const shown = rows.filter((r) => r.pos < SHOW || r.prevPos < SHOW);
    const board = h('div', { style: `position:relative;height:${perCol * ROW}px;max-width:${big ? 960 : 1600}px;overflow:hidden` });
    const els = shown.map((r) => {
      const score = h('span', { class: 'sc', style: `font-size:${big ? 1.8 : 1.35}rem;min-width:60px;text-align:right` }, r.prev);
      const arrow = h('span', { style: `width:${big ? 70 : 48}px;font-weight:800;font-size:${big ? 1.2 : 1}rem;opacity:0;transition:opacity .4s` },
        r.prevPos > r.pos ? `▲${r.prevPos - r.pos}` : r.prevPos < r.pos ? `▼${r.pos - r.prevPos}` : '');
      arrow.style.color = r.prevPos > r.pos ? 'var(--good)' : 'var(--bad)';
      const gain = h('span', { class: 'pts ' + (r.gain >= 0 ? 'pos' : 'neg'), style: `font-size:${big ? 1.25 : 1}rem;margin-right:8px;opacity:0;transition:opacity .4s` },
        r.gain ? fmtPts(r.gain) + (r.chip ? ` (${r.chip}× boost)` : '') : '');
      const rank = h('span', { class: 'rk', style: `width:46px;font-size:${big ? 1.6 : 1.25}rem` }, r.prevPos + 1);
      const at = place(r.prevPos);
      const row = h('div', { class: 'card', style: `margin:0;position:absolute;width:${cols === 2 ? 'calc(50% - 8px)' : '100%'};height:${ROW - 8}px;padding:0 14px;display:flex;align-items:center;gap:10px;box-shadow:3px 3px 0 var(--ink);transition:top 1.3s cubic-bezier(.5,-0.3,.4,1.3), left 1.3s ease;top:${at.top}px;left:${at.left}` },
        rank, h('span', { class: 'nm', style: `flex:1;font-size:${big ? 1.6 : 1.2}rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap` }, r.name), gain, arrow, score);
      return { r, row, score, arrow, gain, rank };
    });
    board.append(...els.map((e) => e.row));
    const finish = () => els.forEach((e) => {
      const to = place(e.r.pos); e.row.style.top = `${to.top}px`; e.row.style.left = to.left;
      e.rank.textContent = e.r.rank; e.score.textContent = e.r.score;
      e.arrow.style.opacity = 1; e.gain.style.opacity = 1;
      if (e.r.pos === 0) e.row.style.background = 'var(--accent)';
    });
    const elapsed = Date.now() - animStart[key];
    if (elapsed > 3000) { setTimeout(finish, 0); }
    else {
      setTimeout(() => {
        els.forEach((e) => { e.gain.style.opacity = 1; });
        const t0 = Date.now();
        const count = setInterval(() => {
          const k = Math.min(1, (Date.now() - t0) / 1200);
          els.forEach((e) => { e.score.textContent = Math.round(e.r.prev + (e.r.score - e.r.prev) * k); });
          if (k >= 1) clearInterval(count);
        }, 40);
        Sound.pop();
      }, Math.max(0, 600 - elapsed));
      setTimeout(() => { finish(); Sound.fanfare(); }, Math.max(0, 1500 - elapsed));
    }
    const boosted = (sl.results || []).filter((r) => r.chip);
    return h('div', { class: 'tv-main' },
      h('div', { class: 'row between' }, h('span', { class: 'pill yellow', style: 'font-size:1.2rem' }, `After question ${sl.idx + 1} of ${sl.total}`)),
      h('h1', { class: 'tv-title', style: 'margin:10px 0 18px' }, 'Top ', h('em', null, 'players')),
      board,
      boosted.length ? h('div', { class: 'chipline' }, h('span', { style: 'font-size:1.2rem;font-weight:700;align-self:center' }, 'Boosts this round:'),
        boosted.map((d) => h('span', { class: 'pill', style: 'background:' + (d.pts >= 0 ? 'var(--good)' : 'var(--bad)') }, `${d.name} ${d.chip}× ${fmtPts(d.pts)}`))) : null);
  }

  let cdTimer;
  let autoFired = '';
  function liveMain(sl) {
    const key = `${sl.idx}:${sl.step}`;
    const left = () => Math.max(0, Math.ceil(((sl.deadline || 0) - (Date.now() + skew)) / 1000));
    const cd = h('div', { class: 'countdown', style: 'font-size:7rem' }, left());
    let lastTick = null;
    clearInterval(cdTimer);
    if (sl.deadline) cdTimer = setInterval(() => {
      const l = left();
      cd.textContent = l;
      cd.style.color = l <= 5 ? 'var(--pop)' : '';
      if (l <= 5 && l > 0 && l !== lastTick) { lastTick = l; Sound.tick(l <= 3); }
      if (l <= 0 && autoFired !== key) { autoFired = key; advance(key); } // time's up: reveal
    }, 200);
    const isText = sl.prompt.kind === 'text' || sl.prompt.kind === 'funny';
    if (!isText) { clearInterval(cdTimer); cd.textContent = ''; }
    const opts = sl.options.map((o) => h('div', { class: 'bar', style: 'min-height:58px' },
      h('span', null, h('b', { style: 'display:inline-block;width:46px;padding:0;font-family:var(--serif);color:var(--pop)' }, o.letter), o.label)));
    return h('div', { class: 'tv-main' },
      h('div', { class: 'row between' }, h('span', { class: 'pill yellow', style: 'font-size:1.2rem' }, `Question ${sl.idx + 1} of ${sl.total}`),
        h('span', { style: 'font-size:1.3rem;font-weight:700' }, sl.prompt.kind === 'funny' ? 'Vote for the funniest on your phone!' : isText ? 'Vote on your phone!' + (CFG.boosts ? ' Use a boost if you\u2019re sure' : '') : 'Everyone\u2019s answers are locked in')),
      h('div', { class: 'tv-q' }, sl.prompt.text),
      isText && sl.first_text ? h('div', { class: 'reveal-banner', style: 'margin:0 0 18px;font-size:1.5rem;font-family:var(--sans);animation:none' },
        h('strong', null, '\u26a1 New: boosts! '), 'Everyone has one 2\u00d7 and one 3\u00d7 boost for the write-in rounds. Sure about one? Use a boost on your phone. Right: your right-answer points \u00d72 or \u00d73. Wrong: lose 10 or 15. One use each!') : null,
      h('div', { class: 'row', style: 'gap:28px;align-items:flex-start;flex-wrap:nowrap;min-height:0' },
        h('div', { class: 'bars', style: 'flex:1;min-width:0' }, opts.slice(0, 8),
          sl.options.length > 8 ? h('div', { class: 'muted', style: 'font-size:1.2rem' }, `+${sl.options.length - 8} more on your phone`) : null),
        h('div', { class: 'center', style: 'min-width:240px;display:flex;flex-direction:column;align-items:center;gap:10px' }, cd,
          h('div', { style: 'font-size:1.4rem;font-weight:700' }, isText ? `${sl.votes_in} of ${S.players.length} voted` : 'Press Space to reveal'),
          photo(230, 250, 3))));
  }

  function finalMain() {
    const f = S.final;
    const left = () => Math.max(0, Math.ceil((f.deadline - (Date.now() + skew)) / 1000));
    const cd = h('div', { class: 'countdown' }, left());
    clearInterval(cdTimer);
    let lastTick = null;
    cdTimer = setInterval(() => {
      const l = left(); cd.textContent = l > 0 ? l : 'Time\u2019s up!';
      if (l <= 5 && l > 0 && l !== lastTick) { lastTick = l; Sound.tick(l <= 3); }
    }, 200);
    return h('div', { class: 'tv-main' },
      h('span', { class: 'pill pink', style: 'font-size:1.3rem;align-self:flex-start' }, 'FINAL QUESTION · bet up to half your points'),
      h('div', { class: 'tv-q' }, f.prompt.text),
      f.prompt.kind === 'number'
        ? h('div', { style: 'font-size:2rem;font-weight:700' }, 'Type your exact guess on your phone, then bet. Exact wins \u2014 or the closest if nobody nails it!')
        : h('div', { class: 'bars' }, (f.prompt.options || []).map((o) => h('div', { class: 'bar' }, h('span', null, o)))),
      h('div', { class: 'row', style: 'gap:30px;margin-top:20px' }, cd, h('div', { style: 'font-size:2rem;font-weight:700' }, `${f.wagers_in} of ${S.players.length} bets in`)));
  }

  // Final: drumroll -> the answer + closest guesses -> 5th, 4th, 3rd, 2nd -> drumroll -> the winner.
  // Times live in common.js (FINALE_MS) so the phones hold back until the winner is out.
  function finalRevealMain() {
    const f = S.final || {};
    if (!animStart.final) animStart.final = Date.now();
    const lb = S.leaderboard || [];
    const n = Math.min(5, lb.length);
    const T = finaleTimes(n);
    const isNum = f.prompt && f.prompt.kind === 'number';
    const ws = [...(f.wagers || [])];
    const close = isNum ? ws.filter((w) => w.err != null).sort((a, b) => a.err - b.err).slice(0, 5) : ws.filter((w) => w.amount > 0).slice(0, 5);
    const wrap = h('div', { class: 'tv-main' });
    let last = null;
    const row = (r, big) => h('div', { class: 'card', style: `display:flex;align-items:center;gap:16px;margin-top:10px;padding:${big ? 18 : 12}px 20px;animation:pop .45s ease${r.rank === 1 ? ';background:var(--accent)' : ''}` },
      h('span', { style: `font-family:var(--serif);font-size:${big ? 3 : 2}rem;width:80px` }, ordinal(r.rank)),
      h('span', { style: `flex:1;font-size:${big ? 2.6 : 1.8}rem;font-weight:800` }, r.name),
      h('span', { style: `font-family:var(--serif);font-size:${big ? 2.6 : 1.8}rem` }, r.score + ' pts'));
    const draw = () => {
      const t = Date.now() - animStart.final;
      let stage;
      if (t < T.roll1) stage = 'roll1';
      else if (t < T.answer) stage = 'answer';
      else if (t < T.places) stage = 'p' + Math.floor((t - T.answer) / T.per); // reveals n..2
      else if (t < T.roll2) stage = 'roll2';
      else stage = 'winner';
      if (stage === last) return;
      const resumed = last === null && t > 800;
      last = stage;
      if (!resumed) {
        if (stage === 'roll1') Sound.drumroll(T.roll1 / 1000);
        else if (stage === 'answer') Sound.fanfare();
        else if (stage[0] === 'p') Sound.pop();
        else if (stage === 'roll2') Sound.drumroll((T.roll2 - T.places) / 1000);
        else Sound.winner();
      }
      const title = h('div', { class: 'tv-q', style: 'margin-bottom:8px' }, f.prompt ? f.prompt.text : '');
      if (stage === 'roll1') {
        wrap.replaceChildren(title, h('div', { class: 'center', style: 'font-family:var(--serif);font-size:clamp(2.4rem,6vw,4rem);margin-top:40px' }, 'The answer is… 🥁'));
        return;
      }
      const answer = h('div', { class: 'reveal-banner', style: 'margin-top:0' }, 'Answer: ', h('strong', null, f.host_answer || '?'),
        close.length ? h('div', { style: 'font-family:var(--sans);font-size:1.15rem;margin-top:8px' },
          isNum ? 'Closest: ' + close.map((w) => `${w.name} ${w.answer} (${fmtPts(w.delta)})`).join('   ·   ')
            : close.map((w) => `${w.name} ${fmtPts(w.delta)}`).join('   ·   ')) : null);
      if (stage === 'answer') { wrap.replaceChildren(...[title, answer].filter(Boolean)); return; }
      const shownUpTo = stage[0] === 'p' ? n - Number(stage.slice(1)) : 2; // lowest rank currently revealed
      const places = [];
      for (let k = n; k >= Math.max(2, shownUpTo); k--) if (lb[k - 1]) places.push(row(lb[k - 1], false));
      if (stage === 'roll2') {
        wrap.replaceChildren(h('h1', { class: 'tv-title', style: 'margin:0 0 6px' }, 'Final ', h('em', null, 'standings')), ...places,
          h('div', { class: 'center', style: 'font-family:var(--serif);font-size:clamp(2rem,5vw,3.4rem);margin-top:26px' }, 'And the winner is… 🥁'));
        return;
      }
      if (stage === 'winner') {
        clearInterval(animTimer);
        const w = lb[0];
        const COLORS = ['var(--accent)', 'var(--pink)', 'var(--water)', 'var(--pop)', 'var(--good)'];
        const confetti = h('div', { class: 'confetti' }, Array.from({ length: 48 }, (_, i) =>
          h('i', { style: `left:${(i * 37) % 100}%;background:${COLORS[i % COLORS.length]};transform:rotate(${(i * 47) % 360}deg);animation-delay:${(i % 9) * 0.3}s;animation-duration:${3 + (i % 5) * 0.6}s` })));
        wrap.replaceChildren(confetti,
          h('div', { class: 'center', style: 'margin-top:10px' }, mascot('bob'),
            h('div', { style: 'font-size:1.6rem;font-weight:700;margin-top:6px' }, 'The winner is'),
            h('div', { style: 'font-family:var(--serif);font-size:6rem;line-height:1.05;margin:8px 0;animation:pop .6s ease' }, w ? w.name : '?'),
            h('div', { style: 'font-size:2rem;font-weight:800' }, w ? `${w.score} points` : '')),
          h('div', { style: 'max-width:900px;margin:18px auto 0;width:100%' }, ...[...places].reverse()));
        return;
      }
      wrap.replaceChildren(...[h('h1', { class: 'tv-title', style: 'margin:0 0 6px' }, 'Final ', h('em', null, 'standings')), ...places].filter(Boolean));
    };
    clearInterval(animTimer);
    animTimer = setInterval(draw, 150);
    draw();
    return wrap;
  }

  // Wall poster (US Letter). Open /tv?print=1 on the logged-in laptop and print.
  // The QR carries the join code, which stays the same across Reset game (only New QR code changes it).
  function printView() {
    const list = photos();
    const pick = list.length ? (POSTER_PHOTO || 0) % list.length : -1;
    const img = pick >= 0 ? h('img', { src: list[pick], alt: '' }) : null;
    if (img) img.onerror = () => { img.style.visibility = 'hidden'; };
    const step = (n, t, sub) => h('div', { class: 'pz-step' }, h('b', null, n), h('div', null, h('strong', null, t), h('span', null, sub)));
    return h('div', { class: 'poster' },
      h('div', { class: 'pz-top' },
        h('div', null,
          h('div', { class: 'pz-kicker' }, mascot(), CFG.title),
          h('h1', null, fancyTitle(CFG.subtitle || CFG.title))),
        img ? h('div', { class: 'pz-photo' }, img) : mascot('pz-mascot')),
      h('div', { class: 'pz-mid' },
        h('div', { class: 'pz-qr' }, qrNode(330), h('div', { class: 'pz-scan' }, 'Scan to play')),
        h('div', { class: 'pz-steps' },
          step('1', 'Scan with your phone camera', 'No app, no sign-up. Just type your name.'),
          step('2', `Answer ${S.prompt_count} quick questions`, `Guess ${hostName()}\u2019s answers, or just be funny.`),
          step('3', 'Vote together at the TV', 'Most points wins.'))),
      CFG.closes_text ? h('div', { class: 'pz-foot' }, CFG.closes_text) : h('div', { class: 'pz-foot' }, 'Scan the code to join'),
      h('div', { class: 'noprint pz-tools' },
        h('button', { class: 'btn', onclick: () => window.print() }, 'Print'),
        list.length > 1 ? h('button', { class: 'btn ghost', onclick: () => { location.search = `?print=1&photo=${(pick + 1) % list.length}`; } }, 'Different photo') : null,
        h('span', { class: 'small muted' }, 'The QR code stays valid unless you tap New QR code in admin')));
  }

  // What "next" means right now (Space, the Next button, or the timer running out).
  async function advance(fromKey) {
    if (!S || !token) return;
    const H = { 'x-admin': token };
    const sl = S.slide;
    let body = null;
    if (S.phase === 'vote') body = { action: 'phase', to: 'reveal' };
    else if (S.phase === 'reveal' && sl) {
      const last = sl.idx >= sl.total - 1 && sl.step === 2;
      body = last ? { action: 'phase', to: S.has_final ? 'final' : 'final_reveal' } : { action: 'next', from: fromKey || `${sl.idx}:${sl.step}` };
    } else if (S.phase === 'final') body = { action: 'phase', to: 'final_reveal' };
    if (!body) return;
    try { await call('/api/admin/action', { body, headers: H }); } catch (e) { toast(e.message, true); }
    load(true);
  }
  function nextLabel() {
    if (!S) return null;
    const sl = S.slide;
    if (S.phase === 'vote') return 'Start TV voting';
    if (S.phase === 'reveal' && sl) {
      if (sl.step === 0) return sl.prompt.kind === 'mc' ? 'Reveal answer' : 'Reveal now';
      if (sl.step === 1) return 'Leaderboard';
      if (sl.idx >= sl.total - 1) return S.has_final ? 'Final question' : 'Show winner';
      return 'Next question';
    }
    if (S.phase === 'final') return 'Reveal winner';
    return null;
  }
  window.addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); advance(); }
    if (e.key === 'm' || e.key === 'M') { Sound.toggle(); lastSoundKey = ''; render(true); }
  });
  let lastSoundKey = '';
  function soundFor() {
    const k = `${S.phase}:${S.slide ? S.slide.idx + ':' + S.slide.step : ''}`;
    if (k === lastSoundKey) return;
    lastSoundKey = k;
    if (S.phase === 'reveal' && S.slide && S.slide.step === 0) Sound.startLoop();
    else if (S.phase === 'reveal' && S.slide && S.slide.step === 1) Sound.stopLoop(); // the showcase plays its own sounds
    else if (S.phase === 'final') Sound.startLoop();
    else if (S.phase === 'final_reveal') Sound.stopLoop(); // the finale plays its own sounds
    else Sound.stopLoop();
  }
  function controls() {
    const label = nextLabel();
    return h('div', { class: 'tv-controls noprint' },
      h('button', { class: 'btn sm ' + (Sound.isOn() ? 'dark' : 'pink'), onclick: () => { Sound.toggle(); lastSoundKey = ''; render(true); } }, Sound.isOn() ? '\ud83d\udd0a Music on \u00b7 tap to mute' : '\ud83d\udd07 Music off \u00b7 tap to play'),
      label ? h('button', { class: 'btn sm', onclick: () => advance() }, label + '  \u25b6') : null,
      h('span', { class: 'small muted' }, label ? 'Space = next \u00b7 M = mute' : 'M = mute'));
  }

  function render(force) {
    if (!token) { document.body.classList.remove('tv'); app.replaceChildren(loginView()); return; }
    if (!S) return;
    // avoid re-rendering (and restarting animations) when nothing visible changed
    const key = JSON.stringify([S.phase, S.slide, S.players, S.leaderboard, S.final, S.join_code, S.cfg, Sound.isOn()]);
    if (!force && key === lastKey) return;
    lastKey = key;
    clearInterval(cdTimer); clearInterval(animTimer); clearInterval(photoTimer);
    if (S.phase !== 'final_reveal') delete animStart.final;
    if (PRINT) { document.body.classList.remove('tv'); app.replaceChildren(printView()); return; }
    document.body.classList.add('tv');
    let main;
    switch (S.phase) {
      case 'answer': main = answerMain(); break;
      case 'vote': main = voteMain(); break;
      case 'reveal': main = revealMain(); break;
      case 'final': main = finalMain(); break;
      case 'final_reveal': main = finalRevealMain(); break;
    }
    const showSide = S.phase === 'final';
    const live = S.phase === 'reveal' && S.slide && S.slide.step === 0;
    app.replaceChildren(h('div', { class: 'tv-wrap', style: showSide && !live ? '' : 'grid-template-columns:minmax(0,1fr)' }, main, showSide && !live ? side() : ''), controls());
    soundFor();
  }

  render(true);
  if (token) load(true); else demoLogin().then((t) => { if (t) { token = t; load(true); } });
  // 2s while the TV is driving the reveal or final, 4s otherwise; paused while the tab is hidden
  (function tick() {
    const fast = S && (S.phase === 'reveal' || S.phase === 'final');
    setTimeout(() => { if (!document.hidden) load(); tick(); }, fast ? 2000 : 4000);
  })();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  window.addEventListener('resize', () => render(true));
})();
