(() => {
  const app = $('#app');
  const qs = new URLSearchParams(location.search);
  if (qs.get('c')) store.set('ap_code', qs.get('c'));
  // host-issued rejoin link: /play?c=..&t=<token>
  if (qs.get('t')) { store.set('ap_token', qs.get('t')); history.replaceState(null, '', '/play' + (qs.get('c') ? '?c=' + encodeURIComponent(qs.get('c')) : '')); }
  let token = store.get('ap_token');
  let S = null;            // last full state
  let skew = 0;            // server clock - local clock
  let busy = false;
  const ui = { ansIdx: null, voteIdx: null, drafts: {}, rules: false, finalPick: null, finalAmt: null, lastPhase: null };

  const headers = () => (token ? { 'x-player': token } : {});

  async function poll(force) {
    if (busy && !force) return;
    try {
      const v = !force && S && S.ver ? '?v=' + S.ver : '';
      const st = await call('/api/state' + v, { headers: headers() });
      if (st.same) return;
      if (st.joined === false) {
        if (token) { token = null; store.del('ap_token'); }
        // only redraw the join screen if something on it changed, so typing isn't wiped
        const changed = !S || S.joined !== false || S.joins_open !== st.joins_open || JSON.stringify(S.cfg) !== JSON.stringify(st.cfg);
        if (st.cfg) applyCfg(st.cfg);
        S = st;
        if (changed) render();
        return;
      }
      setState(st, true);
    } catch (e) { /* network blip: try again next tick */ }
  }

  // While someone is typing or dragging, a background refresh must not redraw the page
  // (that wipes the box and closes the keyboard). Redraw when they leave the field instead.
  let pending = false;
  const typing = () => { const a = document.activeElement; return !!(a && app.contains(a) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)); };
  document.addEventListener('focusout', () => setTimeout(() => { if (pending && !typing()) { pending = false; render(); } }, 0));

  function setState(st, fromPoll) {
    if (st.server_now) skew = st.server_now - Date.now();
    if (st.cfg) applyCfg(st.cfg);
    const phaseChanged = st.phase !== ui.lastPhase;
    S = st;
    if (phaseChanged) {
      ui.lastPhase = S.phase;
      ui.ansIdx = null; ui.voteIdx = null;
      finalSeenAt = null;
    }
    if (fromPoll && !phaseChanged && typing()) { pending = true; return; }
    pending = false;
    render();
  }

  async function act(path, body) {
    busy = true;
    try { setState(await call(path, { body, headers: headers() })); return true; }
    catch (e) {
      toast(e.message, true);
      if (e.status === 401) { token = null; store.del('ap_token'); S = null; poll(true); }
      else poll(true);
      return false;
    } finally { busy = false; }
  }

  // ---------- views ----------
  function topbar() {
    return h('div', { class: 'topbar' },
      h('div', { class: 'row' }, mascot('bob'), h('span', { class: 'who' }, S.me.name)),
      h('div', { class: 'row' },
        S.score != null ? h('span', { class: 'pill yellow' }, S.score + ' pts') : null,
        h('button', { class: 'linkbtn', onclick: () => { ui.rules = true; render(); } }, 'How to play')));
  }

  function rulesModal() {
    return h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === e.currentTarget) { ui.rules = false; render(); } } },
      h('div', { class: 'modal' },
        h('h2', null, 'How to ', h('em', null, 'play')),
        h('ul', null, rules(S && S.prompts).map((r) => h('li', null, r))),
        h('button', { class: 'btn block', onclick: () => { ui.rules = false; render(); } }, 'Got it')));
  }

  function joinView() {
    const code = store.get('ap_code');
    const hero = h('div', { class: 'hero' }, mascot('bob'), h('h1', null, fancyTitle(CFG.subtitle || CFG.title)));
    if (!code) {
      return h('div', { class: 'wrap' }, hero, h('div', { class: 'card center' },
        h('p', null, 'Scan the QR code on the TV to join the game.')));
    }
    if (S && S.joins_open === false) {
      return h('div', { class: 'wrap' }, hero, h('div', { class: 'card center' }, h('p', null, `Joining is closed for now. Ask ${hostName()}!`)));
    }
    const input = h('input', { class: 'input', maxlength: 20, placeholder: 'Your name', autocomplete: 'given-name', enterkeyhint: 'go' });
    const go = async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      btn.disabled = true;
      try {
        const r = await call('/api/join', { body: { name, code } });
        token = r.token; store.set('ap_token', token);
        await poll(true);
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    const btn = h('button', { class: 'btn block', onclick: go }, 'Join the game');
    return h('div', { class: 'wrap' }, hero,
      h('div', { class: 'card stack' },
        h('p', null, 'Answer a few questions on your phone, then everyone votes together at the TV.' + (CFG.closes_text ? ' ' + CFG.closes_text + '.' : '')),
        h('label', { class: 'lbl' }, 'Your name'), input, btn,
        h('p', { class: 'small muted center' }, 'Use the name people know you by. You can’t change it later.')));
  }

  function progressBar(i, n) {
    return h('div', { class: 'progress' }, h('i', { style: `width:${Math.round((i / Math.max(n, 1)) * 100)}%` }));
  }

  function answerView() {
    const P = S.prompts;
    const my = S.my.answers;
    if (ui.ansIdx == null) { const first = P.findIndex((p) => my[p.id] == null); ui.ansIdx = first === -1 ? P.length : first; }
    const done = P.filter((p) => my[p.id] != null).length;
    if (ui.ansIdx >= P.length) {
      return h('div', null,
        h('div', { class: 'card center stack' }, mascot('bob'),
          h('h2', null, done === P.length ? 'All ' : 'Almost ', h('em', null, done === P.length ? 'answered!' : 'there')),
          h('p', { class: 'muted' }, done === P.length ? (CFG.closes_text ? CFG.closes_text + '. ' : '') + 'When answers close, everyone votes together at the TV. Keep this page handy: the options show up right here.' : `You’ve answered ${done} of ${P.length}.`)),
        h('div', { class: 'card flat' }, h('h3', null, 'Your answers'),
          P.map((p, i) => h('div', { class: 'row between', style: 'padding:8px 0;border-bottom:1px dashed var(--line)' },
            h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'small muted' }, p.text), h('div', { style: 'font-weight:700' }, my[p.id] ?? '—')),
            h('button', { class: 'btn sm ghost', onclick: () => { ui.ansIdx = i; render(); } }, my[p.id] == null ? 'Answer' : 'Edit')))));
    }
    const i = ui.ansIdx, p = P[i];
    const next = () => { ui.ansIdx = i + 1; render(); window.scrollTo(0, 0); };
    let body;
    if (p.kind === 'mc') {
      body = (p.options || []).map((o) => h('button', {
        class: 'opt' + (my[p.id] === o ? ' on' : ''),
        onclick: async () => { if (await act('/api/answer', { prompt_id: p.id, text: o })) next(); },
      }, o));
    } else {
      const input = h('input', { class: 'input', maxlength: 60, placeholder: 'Your answer', enterkeyhint: 'next', value: ui.drafts[p.id] ?? my[p.id] ?? '' });
      input.addEventListener('input', () => { ui.drafts[p.id] = input.value; });
      const save = async () => {
        const t = input.value.trim();
        if (!t) { input.focus(); return; }
        if (await act('/api/answer', { prompt_id: p.id, text: t })) { delete ui.drafts[p.id]; next(); }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      body = [input, h('button', { class: 'btn block', style: 'margin-top:12px', onclick: save }, i === P.length - 1 ? 'Save' : 'Save & next')];
      setTimeout(() => { if (!input.value) input.focus(); }, 50);
    }
    return h('div', null,
      h('div', { class: 'row between small muted', style: 'margin-bottom:8px' }, h('span', null, `Question ${i + 1} of ${P.length}`), h('span', null, `${done} answered`)),
      progressBar(done, P.length),
      h('div', { class: 'card', style: 'margin-top:14px' },
        p.kind === 'mc'
          ? h('p', { class: 'small muted' }, `Pick what ${hostName()} would pick. +5 if you’re right.`)
          : p.kind === 'funny'
            ? h('div', { class: 'warn', style: 'margin:0 0 12px' },
              h('strong', null, i === P.findIndex((x) => x.kind === 'funny') ? 'Funny round! ' : 'Funny round. '),
              'There’s no right answer: write the funniest thing you can. Everyone votes later: ',
              h('strong', null, '+2'), ' for every vote yours gets.')
            : h('div', { class: 'warn', style: 'margin:0 0 12px' },
              h('strong', null, i === P.findIndex((x) => x.kind === 'text') ? 'New round: write your own answer! ' : 'Write your own answer. '),
              'Everyone votes on these later, so there are 2 ways to score: ',
              h('strong', null, '+5'), ` if you match ${hostName()}, and `,
              h('strong', null, '+1'), ' for every vote your answer gets.'),
        h('h2', null, p.text), body),
      h('div', { class: 'row between', style: 'margin-top:14px' },
        h('button', { class: 'linkbtn', disabled: i === 0, onclick: () => { ui.ansIdx = Math.max(0, i - 1); render(); } }, '← Back'),
        h('button', { class: 'linkbtn', onclick: next }, 'Skip →')));
  }

  function betRow(p) {
    const chips = S.my.chips;
    const on = (m) => chips[m] === p.id;
    const used = (m) => chips[m] != null && chips[m] !== p.id;
    const none = !on(2) && !on(3);
    if (p.kind !== 'text' || !CFG.boosts) return null;
    if (used(2) && used(3)) return h('p', { class: 'small muted', style: 'margin-top:14px' }, 'Both your boosts are used.');
    return h('div', null,
      h('div', { class: 'row between', style: 'margin-top:18px' }, h('strong', null, 'Use a boost on this one?'), h('span', { class: 'small muted' }, 'Right = \u00d7 your right-answer points \u00b7 wrong = \u221210 / \u221215')),
      h('div', { class: 'bets' },
        h('button', { class: 'bet' + (none ? ' on' : ''), onclick: () => { [2, 3].filter(on).forEach((m) => act('/api/chip', { mult: m, prompt_id: null })); } }, 'No boost'),
        [2, 3].map((m) => h('button', {
          class: 'bet' + (on(m) ? ' on' : ''), disabled: used(m),
          onclick: () => act('/api/chip', { mult: m, prompt_id: on(m) ? null : p.id }),
        }, `${m}×`, h('small', null, used(m) ? 'used' : on(m) ? 'bet!' : 'available')))));
  }

  // Answers are locked; everyone heads to the TV for voting together.
  function voteView() {
    return h('div', null,
      h('div', { class: 'card center stack' }, mascot('bob'),
        h('h2', null, 'Answers are ', h('em', null, 'in!')),
        h('p', null, 'Head to the TV. Voting happens all together, one question at a time.'),
        h('p', { class: 'small muted' }, 'Keep this page open: the options will pop up right here on your phone.')),
      h('div', { class: 'card flat' }, h('h3', null, 'How you score'),
        h('ul', { style: 'padding-left:18px;line-height:1.6;margin:0' },
          rules(S.prompts).slice(1).map((r) => h('li', null, r)))));
  }

  // Live: the question on the TV, with a countdown, vote buttons and the boost.
  let liveTimer;
  function liveVoteView() {
    const sl = S.slide;
    const p = S.prompts.find((x) => x.id === sl.prompt.id) || sl.prompt;
    const left = () => Math.max(0, Math.ceil(((sl.deadline || 0) - (Date.now() + skew)) / 1000));
    const cd = h('span', { class: 'pill yellow', style: 'font-size:1rem' }, left() + 's');
    clearInterval(liveTimer);
    liveTimer = setInterval(() => { const l = left(); cd.textContent = l > 0 ? l + 's' : 'Time’s up!'; if (l <= 0) clearInterval(liveTimer); }, 250);
    let body;
    {
      const list = (S.vote_options || {})[p.id] || [];
      const mine = S.my.votes[p.id];
      const funny = p.kind === 'funny';
      const ownId = S.my.groups && S.my.groups[p.id];
      body = h('div', null,
        h('p', { class: 'muted' }, mine ? 'Locked in! You can change it until time’s up.' : funny ? 'Vote for the funniest one (not your own!)' : `Which answer is ${hostName()}’s?`),
        list.map((c, i) => h('button', {
          class: 'opt' + (mine === c.id ? ' on' : ''),
          disabled: funny && ownId === c.id,
          onclick: () => act('/api/vote', { prompt_id: p.id, cluster_id: c.id }),
        }, h('span', null, `${String.fromCharCode(65 + i)}.  ${c.label}`), ownId === c.id ? h('span', { class: 'tag' }, 'yours') : null)));
    }
    return h('div', null,
      h('div', { class: 'row between small muted', style: 'margin-bottom:8px' }, h('span', null, `Question ${sl.idx + 1} of ${sl.total}`), cd),
      sl.first_text ? h('div', { class: 'warn', style: 'margin:0 0 12px' },
        h('strong', null, '\u26a1 New: boosts! '), 'You have one 2\u00d7 and one 3\u00d7 boost for the write-in rounds. Use one on a question you\u2019re sure about: if you\u2019re right, your right-answer points get multiplied. If you\u2019re wrong, you lose 10 (2\u00d7) or 15 (3\u00d7). One use each.') : null,
      h('div', { class: 'card' }, h('h2', null, p.text), body, betRow(p)),
      h('p', { class: 'center small muted', style: 'margin-top:12px' }, 'Eyes on the TV for the results.'));
  }

  function leaderboard() {
    return h('div', { class: 'card flat' }, h('h3', null, 'Top ', h('em', null, 'players')),
      h('ol', { class: 'lb' }, (S.leaderboard || []).map((r) => h('li', { class: r.name === S.me.name ? 'me' : '' },
        h('span', { class: 'rk' }, r.rank), h('span', { class: 'nm' }, r.name), h('span', { class: 'sc' }, r.score)))));
  }

  function scoreCard() {
    return h('div', { class: 'card center' },
      h('div', { class: 'small muted' }, 'Your score'),
      h('div', { class: 'score-big' }, S.score),
      S.rank ? h('div', { class: 'muted' }, `${ordinal(S.rank)} of ${S.players}`) : null);
  }

  function revealView() {
    const sl = S.slide;
    if (sl && sl.step === 0) {
      if (sl.prompt.kind === 'text' || sl.prompt.kind === 'funny') return liveVoteView();
      const p = S.prompts.find((x) => x.id === sl.prompt.id) || sl.prompt;
      return h('div', null,
        h('div', { class: 'small muted', style: 'margin-bottom:8px' }, `Question ${sl.idx + 1} of ${sl.total} \u00b7 on the TV`),
        h('div', { class: 'card' }, h('h2', null, p.text), h('p', { class: 'muted' }, 'You picked:'),
          h('div', { class: 'opt on' }, S.my.answers[p.id] ?? 'Nothing (skipped)')),
        h('p', { class: 'center muted', style: 'margin-top:12px' }, 'Eyes on the TV for the answer\u2026'));
    }
    if (sl && sl.step === 1) {
      return h('div', { class: 'card center stack', style: 'margin-top:20px' }, mascot('bob'),
        h('h2', null, 'Eyes on the ', h('em', null, 'TV!')),
        h('p', { class: 'muted' }, 'The answers are being revealed. Your points show up here right after.'));
    }
    const parts = [scoreCard()];
    if (sl) {
      const mine = (S.revealed || []).find((r) => r.prompt_id === sl.prompt.id);
      parts.push(h('div', { class: 'card' },
        h('div', { class: 'small muted' }, `On the TV · Q${sl.idx + 1} of ${sl.total}`),
        h('h2', null, sl.prompt.text),
        sl.step >= 2
          ? h('div', null,
            sl.prompt.kind === 'funny'
              ? h('p', null, 'Crowd favourite: ', h('strong', null, (sl.options && sl.options[0] && sl.options[0].count ? sl.options[0].label : 'nobody voted')))
              : h('p', null, `${HostName()} says: `, h('strong', null, sl.host_answer || '?')),
            mine ? h('p', null, 'You: ', h('span', { class: 'pts ' + (mine.pts >= 0 ? 'pos' : 'neg') }, fmtPts(mine.pts) + ' pts'),
              h('span', { class: 'small muted' }, ' ' + [mine.matched ? 'matched +5' : null, mine.votePts ? `votes +${mine.votePts}` : null, mine.correctVote ? 'right vote +2' : null, mine.popularVote ? 'crowd pick +1' : null, mine.chip ? `${mine.chip}× boost` : null].filter(Boolean).join(' · '))) : null)
          : h('p', { class: 'muted' }, 'Eyes on the TV… the answer is coming.')));
    }
    parts.push(leaderboard());
    return h('div', null, parts);
  }

  let countdownTimer;
  function finalView() {
    const f = S.final;
    if (!f) return h('div', { class: 'card' }, 'Final question coming up…');
    const left = () => Math.max(0, Math.ceil((f.deadline - (Date.now() + skew)) / 1000));
    const cd = h('div', { class: 'score-big center' }, left() + 's');
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => { cd.textContent = left() + 's'; if (left() <= 0) clearInterval(countdownTimer); }, 250);
    if (ui.finalPick == null && S.my.wager) ui.finalPick = S.my.wager.answer;
    if (ui.finalAmt == null) ui.finalAmt = S.my.wager ? S.my.wager.amount : Math.floor(f.max_wager / 2);
    ui.finalAmt = Math.min(ui.finalAmt, f.max_wager);
    const amtLabel = h('strong', null, ui.finalAmt);
    const slider = h('input', { type: 'range', min: 0, max: f.max_wager, step: 1, value: ui.finalAmt, style: 'width:100%;accent-color:var(--pop)' });
    slider.addEventListener('input', () => { ui.finalAmt = Number(slider.value); amtLabel.textContent = ui.finalAmt; });
    const lock = async () => {
      if (!ui.finalPick) { toast(f.prompt.kind === 'number' ? 'Type your guess first' : 'Pick an answer first', true); return; }
      if (await act('/api/wager', { answer: ui.finalPick, amount: ui.finalAmt })) toast('Locked in!');
    };
    return h('div', null,
      h('div', { class: 'card center' }, h('div', { class: 'small muted' }, 'Final question · time left'), cd),
      h('div', { class: 'card' },
        h('h2', null, f.prompt.text),
        f.prompt.kind === 'number'
          ? (() => {
            const inp = h('input', { class: 'input', type: 'text', inputmode: 'decimal', placeholder: 'Your guess, e.g. 8.5', value: ui.finalPick ?? '', style: 'font-size:1.4rem;text-align:center' });
            inp.addEventListener('input', () => { ui.finalPick = inp.value.trim(); });
            return h('div', null, inp, h('p', { class: 'small muted', style: 'margin-top:6px' }, 'Exact answer wins. If nobody\u2019s exact, the closest guess wins.'));
          })()
          : (f.prompt.options || []).map((o) => h('button', { class: 'opt' + (ui.finalPick === o ? ' on' : ''), onclick: () => { ui.finalPick = o; render(); } }, o)),
        h('div', { style: 'margin-top:18px' },
          h('div', { class: 'row between' }, h('span', null, 'Bet: ', amtLabel, ' pts'), h('span', { class: 'small muted' }, `max ${f.max_wager}`)),
          f.max_wager > 0 ? slider : h('p', { class: 'small muted' }, 'You have no points to bet, but you can still pick an answer.'),
          h('div', { class: 'row', style: 'margin-top:8px' },
            h('button', { class: 'btn sm ghost', onclick: () => { ui.finalAmt = 0; render(); } }, 'None'),
            h('button', { class: 'btn sm ghost', onclick: () => { ui.finalAmt = Math.floor(f.max_wager / 2); render(); } }, 'Half'),
            h('button', { class: 'btn sm pink', onclick: () => { ui.finalAmt = f.max_wager; render(); } }, 'Max'))),
        h('button', { class: 'btn block dark', style: 'margin-top:16px', onclick: lock }, S.my.wager ? 'Update bet' : 'Lock it in'),
        S.my.wager ? h('p', { class: 'small muted center', style: 'margin-top:8px' }, `Locked: ${S.my.wager.answer} for ${S.my.wager.amount} pts`) : null),
      scoreCard());
  }

  let finalSeenAt = null;
  function finalRevealView() {
    const f = S.final || {};
    const r = f.result;
    const hold = finaleTimes(Math.min(5, S.players || 5)).total;
    if (!finalSeenAt) { finalSeenAt = Date.now(); setTimeout(render, hold + 200); }
    if (Date.now() - finalSeenAt < hold) {
      return h('div', { class: 'card center stack', style: 'margin-top:20px' }, mascot('bob'),
        h('h2', null, 'Drumroll\u2026 \ud83e\udd41'), h('p', { class: 'muted' }, 'Eyes on the TV!'));
    }
    return h('div', null,
      h('div', { class: 'card center stack' }, mascot('bob'),
        h('h2', null, 'Final: ', h('em', null, f.host_answer || '?')),
        r ? h('p', null, `You bet ${r.amount} on ${r.answer}: `, h('span', { class: 'pts ' + (r.delta >= 0 ? 'pos' : 'neg') }, fmtPts(r.delta))) : h('p', { class: 'muted' }, 'You sat this one out.')),
      scoreCard(), leaderboard(),
      h('p', { class: 'center muted small' }, 'Thanks for playing! \ud83c\udf89'));
  }

  function render() {
    clearInterval(countdownTimer); clearInterval(liveTimer);
    if (!S || !token || S.joined === false || !S.me) { app.replaceChildren(joinView()); return; }
    let main;
    switch (S.phase) {
      case 'answer': main = answerView(); break;
      case 'vote': main = voteView(); break;
      case 'reveal': main = revealView(); break;
      case 'final': main = finalView(); break;
      case 'final_reveal': main = finalRevealView(); break;
      default: main = h('div', { class: 'card' }, 'Hang tight…');
    }
    app.replaceChildren(h('div', { class: 'wrap' }, topbar(), main), ui.rules ? rulesModal() : '');
  }

  render();
  poll(true);
  setInterval(() => {
    if (document.hidden) return;
    poll(false);
  }, 4000);
  // faster polling during the timed final
  setInterval(() => { if (!document.hidden && S && (S.phase === 'final' || S.phase === 'reveal')) poll(false); }, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(false); });
})();
