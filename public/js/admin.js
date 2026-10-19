(() => {
  const app = $('#app');
  let token = store.get('ap_admin');
  let S = null;
  let tab = 'game';
  let draft = null;      // prompts being edited
  let dirty = false;
  let showAnswers = false;  // answers stay hidden on this screen until you tap Show
  let shownPhase = null;
  const PHASE_LABEL = { answer: 'Answering', vote: 'Voting', reveal: 'Reveal', final: 'Final wager', final_reveal: 'Final results' };

  const hdr = () => ({ 'x-admin': token });

  async function load(force) {
    if (!token) return render();
    try {
      const v = !force && S && S.key ? '?v=' + encodeURIComponent(S.key) : '';
      const st = await call('/api/admin/state' + v, { headers: hdr() });
      if (st.same) return;
      S = st; applyCfg(S.cfg, 'admin'); if (S.phase !== shownPhase) { shownPhase = S.phase; showAnswers = false; } render(); }
    catch (e) { if (e.status === 401) { token = null; store.del('ap_admin'); render(); demoLogin().then((t) => { if (t) { token = t; load(); } }); } }
  }

  async function act(body, okMsg) {
    try { S = await call('/api/admin/action', { body, headers: hdr() }); applyCfg(S.cfg, 'admin'); if (S.phase !== shownPhase) { shownPhase = S.phase; showAnswers = false; } if (okMsg) toast(okMsg); render(); return true; }
    catch (e) { toast(e.message, true); return false; }
  }

  function loginView() {
    const pin = h('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'PIN', autocomplete: 'current-password' });
    const go = async () => {
      try { const r = await call('/api/admin/login', { body: { pin: pin.value } }); token = r.token; store.set('ap_admin', token); load(); }
      catch (e) { toast(e.message, true); }
    };
    pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return h('div', { class: 'wrap' }, h('div', { class: 'hero' }, mascot('bob'), h('h1', null, 'Host ', h('em', null, 'HQ'))),
      h('div', { class: 'card stack' }, pin, h('button', { class: 'btn block', onclick: go }, 'Log in')));
  }

  // ---------- game tab ----------
  function stats() {
    const P = S.players;
    const doneA = P.filter((p) => p.done_answering).length;
    const doneV = P.filter((p) => p.done_voting).length;
    return h('div', { class: 'row', style: 'margin:6px 0 4px' },
      h('span', { class: 'pill yellow' }, PHASE_LABEL[S.phase]),
      h('span', { class: 'pill' }, `${P.length} players`),
      h('span', { class: 'pill' }, `${doneA} done answering`),
      S.phase !== 'answer' ? h('span', { class: 'pill' }, `${doneV} done voting`) : null,
      !S.joins_open ? h('span', { class: 'pill pink' }, 'joins closed') : null);
  }

  function missingWarnings() {
    const reg = S.prompts.filter((p) => !p.is_final);
    const fin = S.prompts.find((p) => p.is_final);
    const out = [];
    const missing = reg.filter((p) => p.kind !== 'funny' && !p.host_answer).map((p) => p.text);
    if (missing.length) out.push(h('div', { class: 'warn' }, `No host answer yet for ${missing.length} question(s). Fill them in on the Questions tab before the reveal.`));
    if (!fin) out.push(h('div', { class: 'warn' }, 'No final question set.'));
    else if (!fin.host_answer) out.push(h('div', { class: 'warn' }, 'The final question has no host answer yet.'));
    return out;
  }

  function phaseControls() {
    const c = [];
    const go = (to, msg) => { if (!msg || confirm(msg)) act({ action: 'phase', to }); };
    if (S.phase === 'answer') {
      c.push(h('button', { class: 'btn block', onclick: () => go('vote', 'Close answers? Nobody can answer or change answers after this. Answers get grouped (takes a few seconds) and phones switch to "head to the TV".') }, 'Close answers & group them →'));
    }
    if (S.phase === 'vote') {
      const noMatch = S.prompts.filter((p) => p.kind === 'text' && !p.is_final && S.groups[p.id] && S.groups[p.id].length && !S.groups[p.id].some((g) => g.is_match));
      if (noMatch.length) c.push(h('div', { class: 'warn' }, `${noMatch.length} guess-the-host question(s) have no group ticked as matching your answer. That\u2019s fine: your answer is added as its own option. Tick a group if someone wrote it.`));
      c.push(h('p', { class: 'small', style: 'margin:0 0 10px' }, 'Answers are locked. Tap Show below, merge duplicates and tick the groups that match your answer. Then gather everyone at the TV.'));
      c.push(h('button', { class: 'btn block', onclick: () => go('reveal', 'Start voting together on the TV? Each question gets a timer, then the answer is revealed.') }, 'Start TV voting →'));
      c.push(h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn sm ghost', onclick: () => go('answer', 'Go back to answering? This clears all groups, votes and bets.') }, '← Back to answering'),
        h('button', { class: 'btn sm ghost', onclick: () => { if (confirm('Regroup all answers? Clears votes and your match ticks.')) act({ action: 'regroup' }, 'Regrouped'); } }, 'Regroup')));
    }
    if (S.phase === 'reveal') {
      const reg = S.prompts.filter((p) => !p.is_final);
      const i = S.reveal_idx, st = S.reveal_step;
      const last = i >= reg.length - 1 && st === 2;
      const isText = reg[i] && (reg[i].kind === 'text' || reg[i].kind === 'funny');
      c.push(h('div', { class: 'card flat center' },
        h('div', { class: 'small muted' }, `Question ${i + 1} of ${reg.length} · ${st === 0 ? (isText ? `voting now (${S.cfg.vote_seconds}s timer on TV)` : 'question up, reveal when ready') : st === 1 ? 'revealing answers on TV' : 'leaderboard'}`),
        h('h3', { style: 'margin-top:6px' }, reg[i] ? reg[i].text : ''),
        reg[i] && showAnswers && reg[i].kind !== 'funny' ? h('div', { class: 'small' }, `${HostName()}: `, h('strong', null, reg[i].host_answer || '—')) : null));
      c.push(h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn ghost', style: 'flex:1', onclick: () => act({ action: 'prev' }) }, '← Prev'),
        st === 0 && isText ? h('button', { class: 'btn ghost', style: 'flex:1', onclick: () => act({ action: 'extend' }, '+10s') }, '+10s') : null,
        last ? null : h('button', { class: 'btn', style: 'flex:2', onclick: () => act({ action: 'next', from: `${i}:${st}` }) }, st === 0 ? (isText ? 'Reveal now' : 'Reveal answer') : st === 1 ? 'Leaderboard →' : 'Next question →')));
      if (last) {
        const fin = S.prompts.find((p) => p.is_final);
        c.push(fin
          ? h('button', { class: 'btn block dark', style: 'margin-top:12px', onclick: () => go('final', `Start the ${S.cfg.final_seconds}s final wager now?`) }, 'Start final wager →')
          : h('button', { class: 'btn block dark', style: 'margin-top:12px', onclick: () => go('final_reveal') }, 'Show final results →'));
      }
      c.push(h('button', { class: 'btn sm ghost', style: 'margin-top:10px', onclick: () => go('vote', 'Back to voting?') }, '← Back to voting'));
    }
    if (S.phase === 'final') {
      const left = Math.max(0, Math.ceil(((S.final?.deadline || 0) - S.server_now) / 1000));
      c.push(h('div', { class: 'card flat center' }, h('div', { class: 'score-big' }, left + 's'), h('div', { class: 'muted' }, `${S.final?.wagers_in || 0} of ${S.players.length} bets in`)));
      c.push(h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn ghost', style: 'flex:1', onclick: () => act({ action: 'extend' }, '+20s') }, '+20s'),
        h('button', { class: 'btn dark', style: 'flex:2', onclick: () => go('final_reveal', 'Reveal the final answer and the winner?') }, 'Reveal winner →')));
    }
    if (S.phase === 'final_reveal') {
      c.push(h('p', null, 'Winner is on the TV. 🎉'));
      c.push(h('button', { class: 'btn sm ghost', onclick: () => go('final', 'Re-open the final wager (restarts the timer)?') }, '← Back to final wager'));
    }
    return c;
  }

  function answersToggle() {
    return h('div', { class: 'card flat row between', style: 'margin-top:16px' },
      h('div', { style: 'flex:1;min-width:0' }, h('strong', null, showAnswers ? 'Answers are showing' : 'Answers are hidden'),
        h('div', { class: 'small muted' }, S.phase === 'vote' ? 'Show them to merge duplicates and tick which groups match your answer.' : 'Kept hidden so nobody sees them over your shoulder.')),
      h('button', { class: 'btn sm ' + (showAnswers ? 'dark' : ''), onclick: () => { showAnswers = !showAnswers; render(); } }, showAnswers ? 'Hide' : 'Show'));
  }

  function groupsReview() {
    if (!showAnswers) return answersToggle();
    if (S.phase === 'answer') {
      return h('div', null, answersToggle(), h('div', { class: 'card flat' }, h('h3', null, 'Answers so far'),
        S.prompts.filter((p) => !p.is_final).map((p) => h('div', { style: 'margin-top:10px' },
          h('strong', null, p.text), h('div', { class: 'small muted' }, (S.raw_answers[p.id] || []).map((a) => `${a.name}: ${a.text}`).join(' · ') || 'none yet')))));
    }
    const blocks = S.prompts.filter((p) => (p.kind === 'text' || p.kind === 'funny') && !p.is_final).map((p) => {
      const gs = S.groups[p.id] || [];
      const funny = p.kind === 'funny';
      return h('div', { class: 'card flat' },
        h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, p.text), kindTag(p.kind)),
        funny ? h('div', { class: 'small muted' }, 'Funny round: just merge exact duplicates. No right answer to tick.')
          : h('div', { class: 'small' }, `${HostName()}: `, h('strong', null, p.host_answer || '— not set —')),
        !funny && p.host_answer && !gs.some((g) => g.is_match)
          ? h('div', { class: 'small muted' }, 'No group ticked, so your answer is added to the vote list as its own option.')
          : null,
        gs.length ? gs.map((g) => h('div', { class: 'grp' + (g.is_match && !funny ? ' match' : '') },
          h('div', { class: 'row between' },
            h('label', { class: 'row', style: 'gap:8px;font-weight:700;flex:1' },
              funny ? null : h('input', { type: 'checkbox', checked: g.is_match, onchange: (e) => act({ action: 'match', cluster_id: g.id, is_match: e.target.checked }) }),
              g.label),
            h('span', { class: 'small muted' }, `${g.votes} votes`)),
          h('div', { class: 'ans' }, g.answers.map((a, i) => h('span', null, i ? ' · ' : '', `${a.name}: “${a.text}” `,
            g.answers.length > 1 ? h('button', { class: 'linkbtn', onclick: () => act({ action: 'split', player_id: a.player_id, prompt_id: p.id }) }, 'split') : null))),
          h('div', { class: 'row', style: 'margin-top:6px' },
            gs.length > 1 ? h('select', { class: 'small', onchange: (e) => { if (e.target.value) act({ action: 'merge', from: g.id, to: Number(e.target.value) }); } },
              h('option', { value: '' }, 'Merge into…'), gs.filter((x) => x.id !== g.id).map((x) => h('option', { value: x.id }, x.label))) : null,
            h('button', { class: 'linkbtn', onclick: () => { const l = prompt('Rename group', g.label); if (l) act({ action: 'rename', cluster_id: g.id, label: l }); } }, 'rename'))))
          : h('p', { class: 'muted small' }, 'No answers.'));
    });
    return h('div', null, answersToggle(), h('h3', { style: 'margin-top:18px' }, 'Answer ', h('em', null, 'groups')),
      h('p', { class: 'small muted' }, `Tick every group that counts as ${hostName()}\u2019s answer. Merge duplicates so votes don\u2019t split.`),
      S.ai_status && !S.ai_status.ok ? h('div', { class: 'warn' }, `AI matching (${S.ai_status.provider}) had a problem, so the built-in matching was used: ${(S.ai_status.errors || []).join(' / ')}`) : null,
      blocks);
  }

  function gameTab() {
    return h('div', null, stats(), missingWarnings(),
      h('div', { class: 'card', style: 'margin-top:12px' }, phaseControls()),
      groupsReview(),
      h('div', { class: 'card flat', style: 'margin-top:16px' },
        h('h3', null, 'Setup'),
        h('div', { class: 'row' },
          h('a', { class: 'btn sm', href: '/tv', target: '_blank' }, 'Open TV view'),
          h('a', { class: 'btn sm ghost', href: '/tv?print=1', target: '_blank' }, 'Printable QR')),
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn sm ghost', onclick: () => act({ action: 'joins', open: !S.joins_open }) }, S.joins_open ? 'Close joining' : 'Open joining'),
          h('button', { class: 'btn sm ghost', onclick: () => { if (confirm('Make a new QR code? The old one (and any printed posters) stops working for new joins.')) act({ action: 'rotate_code' }, 'New QR code'); } }, 'New QR code')),
        (S.phase === 'answer' || S.phase === 'final' || (S.phase === 'reveal' && S.reveal_step === 0 && ['text', 'funny'].includes((S.prompts.filter((x) => !x.is_final)[S.reveal_idx] || {}).kind))) ? h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn sm pink', onclick: () => act({ action: 'bots' }, 'Test players done') }, { answer: 'Add 5 test players + their answers', reveal: 'Test players: vote on this question', final: 'Test players: place final bets' }[S.phase]),
          h('span', { class: 'small muted' }, 'For rehearsing. Reset game removes them.')) : null,
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn sm danger', onclick: () => { const c = prompt('This deletes ALL players, answers and votes (questions and the QR code stay). Type RESET'); if (c) act({ action: 'reset', confirm: c }, 'Game reset'); } }, 'Reset game'),
          h('button', { class: 'linkbtn', onclick: () => { store.del('ap_admin'); token = null; render(); } }, 'Log out'))));
  }

  // ---------- prompts tab ----------
  function startDraft() {
    draft = S.prompts.map((p) => ({ id: p.id, text: p.text, kind: p.kind, options: p.options ? [...p.options] : [], host_answer: p.host_answer || '', is_final: !!p.is_final }));
    dirty = false;
  }
  function promptsTab() {
    if (!draft) startDraft();
    const locked = S.phase !== 'answer';
    const mark = () => { dirty = true; };
    const cards = draft.map((p, i) => {
      const opts = h('input', { class: 'input', value: p.options.join(', '), placeholder: 'Option A, Option B, Option C', disabled: locked && p.kind === 'mc' && false });
      opts.addEventListener('input', () => { p.options = opts.value.split(',').map((s) => s.trim()).filter(Boolean); mark(); });
      opts.addEventListener('change', () => render()); // refresh the host-answer dropdown
      const txt = h('textarea', { class: 'input', value: p.text });
      txt.addEventListener('input', () => { p.text = txt.value; mark(); });
      let pa;
      if (p.kind === 'number') {
        pa = h('input', { class: 'input', value: p.host_answer, inputmode: 'decimal', placeholder: 'The exact number, e.g. 12' });
        pa.addEventListener('input', () => { p.host_answer = pa.value; mark(); });
      } else if (p.kind === 'mc') {
        pa = h('select', { class: 'input', onchange: (e) => { p.host_answer = e.target.value; mark(); } },
          h('option', { value: '' }, '— pick —'), p.options.map((o) => h('option', { value: o, selected: o === p.host_answer }, o)));
      } else if (p.kind === 'text') {
        pa = h('input', { class: 'input', value: p.host_answer, placeholder: `What ${hostName()} would say` });
        pa.addEventListener('input', () => { p.host_answer = pa.value; mark(); });
      } else pa = null;
      return h('div', { class: 'card' + (p.is_final ? '' : ' flat'), style: 'margin-top:12px' },
        h('div', { class: 'row between' },
          h('strong', null, p.is_final ? 'FINAL (wager)' : `Q${i + 1}`),
          h('div', { class: 'row' },
            locked ? null : h('button', { class: 'btn sm ghost', onclick: () => { if (i > 0) { [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]]; mark(); render(); } } }, '↑'),
            locked ? null : h('button', { class: 'btn sm ghost', onclick: () => { if (i < draft.length - 1) { [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]]; mark(); render(); } } }, '↓'),
            locked ? null : h('button', { class: 'btn sm danger', onclick: () => { if (confirm('Delete this question (and its answers)?')) { draft.splice(i, 1); mark(); render(); } } }, '✕'))),
        h('label', { class: 'lbl' }, 'Question'), txt,
        h('div', { class: 'row', style: 'margin-top:8px' },
          locked ? kindTag(p.kind)
            : h('select', { onchange: (e) => { p.kind = e.target.value; if (p.kind === 'text' || p.kind === 'funny') p.is_final = false; if (p.kind === 'number') { draft.forEach((x) => { x.is_final = false; }); p.is_final = true; } mark(); render(); } },
              Object.entries(KIND_LABEL).map(([k, l]) => h('option', { value: k, selected: p.kind === k }, l))),
          (p.kind === 'mc' || p.kind === 'number') && !locked ? h('label', { class: 'row small', style: 'gap:6px' }, h('input', { type: 'checkbox', checked: p.is_final, onchange: (e) => { draft.forEach((x) => { x.is_final = false; }); p.is_final = e.target.checked; mark(); render(); } }), 'Final wager question') : null),
        p.kind === 'mc' ? [h('label', { class: 'lbl' }, 'Options (comma separated)'), opts] : null,
        pa ? [h('label', { class: 'lbl' }, `${HostName()}\u2019s answer (hidden until the reveal)`), pa] : h('p', { class: 'small muted', style: 'margin-top:8px' }, 'Funny round: no right answer. Points come from votes.'),
        p.kind === 'mc' && !p.options.length ? h('p', { class: 'small muted', style: 'margin-top:6px' }, 'Type the options above first.') : null);
    });
    return h('div', null,
      locked ? h('div', { class: 'warn' }, 'Answering is closed: you can edit wording and host answers, but not add, remove or reorder.') : packTools(),
      cards,
      locked ? null : h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn sm ghost', onclick: () => { draft.splice(draft.findIndex((x) => x.is_final) === -1 ? draft.length : draft.findIndex((x) => x.is_final), 0, { text: '', kind: 'text', options: [], host_answer: '', is_final: false }); mark(); render(); } }, '+ Guess the host'),
        h('button', { class: 'btn sm ghost', onclick: () => { draft.splice(draft.findIndex((x) => x.is_final) === -1 ? draft.length : draft.findIndex((x) => x.is_final), 0, { text: '', kind: 'mc', options: ['', ''], host_answer: '', is_final: false }); mark(); render(); } }, '+ Multiple choice'),
        h('button', { class: 'btn sm ghost', onclick: () => { draft.splice(draft.findIndex((x) => x.is_final) === -1 ? draft.length : draft.findIndex((x) => x.is_final), 0, { text: '', kind: 'funny', options: [], host_answer: '', is_final: false }); mark(); render(); } }, '+ Funny')),
      h('div', { style: 'position:sticky;bottom:12px;margin-top:16px' },
        h('button', { class: 'btn block dark', onclick: async () => {
          const ok = await act({ action: 'prompts', prompts: draft.map((p) => ({ ...p, host_answer: p.host_answer || null })) }, 'Saved');
          if (ok) startDraft(), render();
        } }, dirty ? 'Save questions •' : 'Save questions'),
        dirty ? h('button', { class: 'linkbtn', style: 'display:block;margin:6px auto 0', onclick: () => { startDraft(); render(); } }, 'Discard changes') : null));
  }

  // Host-assisted rejoin: shows a QR that logs this player back in on whatever phone scans it.
  let relinkInfo = null;
  async function relink(p) {
    if (!confirm(`Show a QR that logs ${p.name} back in? Their old page stops working.`)) return;
    try {
      const r = await call('/api/admin/action', { body: { action: 'relink', player_id: p.id }, headers: hdr() });
      relinkInfo = { name: r.name, url: `${location.origin}/play?c=${encodeURIComponent(r.join_code)}&t=${r.token}` };
      render();
    } catch (e) { toast(e.message, true); }
  }
  function relinkModal() {
    const q = qrcode(0, 'M'); q.addData(relinkInfo.url); q.make();
    const box = document.createElement('div');
    box.style.cssText = 'width:240px;height:240px;margin:12px auto;background:#fff;padding:10px;border-radius:12px';
    box.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    const svg = box.querySelector('svg'); if (svg) { svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%'); }
    return h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === e.currentTarget) { relinkInfo = null; render(); } } },
      h('div', { class: 'modal center' },
        h('h2', null, 'Scan to get ', h('em', null, relinkInfo.name), ' back in'),
        box,
        h('p', { class: 'small muted' }, 'Their score and answers carry over.'),
        h('button', { class: 'btn block', onclick: () => { relinkInfo = null; render(); } }, 'Done')));
  }

  // ---------- question packs + import/export ----------
  const KIND_LABEL = { text: 'Guess the host (write-in)', funny: 'Funny (votes win)', mc: 'Multiple choice', number: 'Number (final only)' };
  function kindTag(k) { return h('span', { class: 'kind-tag ' + k }, { text: 'Guess the host', funny: 'Funny', mc: 'Multiple choice', number: 'Number' }[k] || k); }
  let packs = null;
  function useQuestions(list, label) {
    if (!Array.isArray(list) || !list.length) { toast('No questions in that file', true); return; }
    if (dirty || draft.length) { if (!confirm(`Replace the questions below with ${label}? Nothing is saved until you tap Save questions.`)) return; }
    draft = list.slice(0, 30).map((q) => ({ text: String(q.text || ''), kind: ['mc', 'text', 'funny', 'number'].includes(q.kind) ? q.kind : 'text', options: Array.isArray(q.options) ? q.options.map(String) : [], host_answer: q.host_answer != null ? String(q.host_answer) : '', is_final: !!q.is_final }));
    dirty = true; render();
  }
  function packTools() {
    if (!packs) { packs = []; call('/packs/index.json').then((j) => { packs = j; render(); }).catch(() => {}); }
    const file = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none' });
    file.addEventListener('change', async () => {
      const f = file.files[0]; if (!f) return;
      try { const j = JSON.parse(await f.text()); useQuestions(Array.isArray(j) ? j : j.questions, f.name); } catch { toast('That file isn\u2019t a question pack', true); }
    });
    const exportIt = () => {
      const blob = new Blob([JSON.stringify({ name: CFG.title, questions: draft.map(({ text, kind, options, host_answer, is_final }) => ({ text, kind, ...(kind === 'mc' ? { options } : {}), ...(host_answer ? { host_answer } : {}), ...(is_final ? { is_final } : {}) })) }, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: 'couchside-questions.json' }); document.body.append(a); a.click(); a.remove();
    };
    return h('div', { class: 'card flat' },
      h('h3', null, 'Question ', h('em', null, 'packs')),
      h('div', { class: 'row' },
        h('select', { class: 'input', style: 'flex:1;min-width:160px', onchange: async (e) => {
          const f = e.target.value; e.target.value = ''; if (!f) return;
          try { const j = await call('/packs/' + f); useQuestions(j.questions, `the \u201c${j.name}\u201d pack`); } catch (err) { toast(err.message, true); }
        } }, h('option', { value: '' }, 'Load a pack\u2026'), (packs || []).map((pk) => h('option', { value: pk.file }, pk.name))),
        h('button', { class: 'btn sm ghost', onclick: () => file.click() }, 'Import'),
        h('button', { class: 'btn sm ghost', onclick: exportIt }, 'Export'), file),
      h('p', { class: 'small muted', style: 'margin:8px 0 0' }, 'Loading a pack replaces the list below; edit it, fill in your answers, then Save.'));
  }

  // ---------- settings tab ----------
  let sdraft = null, keyDraft = null, aiResult = null;
  const PROVIDERS = [
    ['none', 'Built-in matching only (no AI)'],
    ['workers-ai', 'Cloudflare Workers AI (free on your account, no key)'],
    ['openai', 'OpenAI-compatible (OpenAI, OpenRouter, Groq\u2026)'],
    ['anthropic', 'Anthropic'],
    ['jev', 'TypeSafe Jev'],
  ];
  const MODEL_HINT = { 'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast', openai: 'gpt-4o-mini', anthropic: 'claude-haiku-5-5', jev: 'jev-latest' };
  function settingsTab() {
    if (!sdraft) sdraft = JSON.parse(JSON.stringify(S.cfg));
    const c = sdraft;
    const field = (label, key, attrs, help) => {
      const el = h('input', { class: 'input', value: c[key] ?? '', ...(attrs || {}) });
      el.addEventListener('input', () => { c[key] = attrs && attrs.type === 'number' ? Number(el.value) : el.value; });
      return [h('label', { class: 'lbl' }, label), el, help ? h('div', { class: 'small muted', style: 'margin-top:4px' }, help) : null];
    };
    const photos = h('textarea', { class: 'input', placeholder: 'https://\u2026/photo1.jpg\nhttps://\u2026/photo2.jpg', value: (c.photos || []).join('\n') });
    photos.addEventListener('input', () => { c.photos = photos.value.split(/\s+/).filter(Boolean); });
    const color = h('input', { type: 'color', class: 'swatch', value: c.accent });
    color.addEventListener('input', () => { c.accent = color.value; document.documentElement.style.setProperty('--accent', c.accent); });
    const boosts = h('input', { type: 'checkbox', checked: !!c.boosts });
    boosts.addEventListener('change', () => { c.boosts = boosts.checked; });
    const prov = h('select', { class: 'input', onchange: (e) => { c.ai.provider = e.target.value; aiResult = null; render(); } },
      PROVIDERS.map(([v, l]) => h('option', { value: v, selected: c.ai.provider === v }, l)));
    const needsKey = ['openai', 'anthropic', 'jev'].includes(c.ai.provider);
    const model = h('input', { class: 'input', value: c.ai.model || '', placeholder: MODEL_HINT[c.ai.provider] || '' });
    model.addEventListener('input', () => { c.ai.model = model.value; });
    const base = h('input', { class: 'input', value: c.ai.base_url || '', placeholder: 'https://api.openai.com/v1' });
    base.addEventListener('input', () => { c.ai.base_url = base.value; });
    const key = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: S.ai_key.set ? `Saved (${S.ai_key.hint}). Type to replace` : 'Paste your API key', value: keyDraft || '' });
    key.addEventListener('input', () => { keyDraft = key.value; });
    const save = async (extra) => {
      const body = { action: 'settings', settings: c };
      if (keyDraft) body.ai_key = keyDraft;
      Object.assign(body, extra || {});
      if (await act(body, 'Settings saved')) { sdraft = null; keyDraft = null; render(); return true; }
      return false;
    };
    const test = async () => {
      if (!(await save())) return;
      aiResult = { pending: true }; render();
      try { aiResult = await call('/api/admin/action', { body: { action: 'ai_test' }, headers: hdr() }); } catch (e) { aiResult = { ok: false, error: e.message }; }
      render();
    };
    return h('div', { class: 'settings' },
      h('div', { class: 'card flat' }, h('h3', null, 'Your ', h('em', null, 'game')),
        field('Game name', 'title', { maxlength: 40 }),
        field('Headline on the TV and phones', 'subtitle', { maxlength: 80, placeholder: 'How well do you know the host?' }),
        field('Who is the host?', 'host_name', { maxlength: 40, placeholder: 'the host' }, 'Shown as \u201cGrandma says: \u2026\u201d. Use a name, \u201cthe birthday girl\u201d, \u201cMr. Lee\u201d\u2026'),
        field('When answers close (optional)', 'closes_text', { maxlength: 60, placeholder: 'Answers close at 7:30' }),
        h('label', { class: 'lbl' }, 'Accent colour'), h('div', { class: 'row' }, color, h('span', { class: 'small muted' }, 'Buttons, highlights and the couch.')),
        h('label', { class: 'lbl' }, 'Photos for the TV (optional)'), photos,
        h('div', { class: 'small muted', style: 'margin-top:4px' }, 'One https:// image link per line. They rotate on the TV screens. Leave empty for none.')),
      h('div', { class: 'card flat' }, h('h3', null, 'Game ', h('em', null, 'rules')),
        field('Seconds to vote on each write-in question', 'vote_seconds', { type: 'number', min: 10, max: 180 }),
        field('Seconds for the final bet', 'final_seconds', { type: 'number', min: 20, max: 300 }),
        h('label', { style: 'display:flex;gap:10px;align-items:flex-start;margin-top:14px' }, boosts, h('span', null, h('strong', null, 'Boosts'), ' (one 2\u00d7 and one 3\u00d7 per player, for guess-the-host rounds)'))),
      h('div', { class: 'card flat' }, h('h3', null, 'Answer ', h('em', null, 'matching')),
        h('p', { class: 'small muted' }, 'When answers close, similar answers are grouped (\u201cpizza\u201d + \u201cPizza!\u201d) and matches to your answer are pre-ticked. You always review them. AI is optional and only helps with synonyms.'),
        h('label', { class: 'lbl' }, 'Provider'), prov,
        c.ai.provider !== 'none' ? [h('label', { class: 'lbl' }, 'Model (optional)'), model] : null,
        c.ai.provider === 'openai' ? [h('label', { class: 'lbl' }, 'Base URL'), base, h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Leave empty for OpenAI. OpenRouter: https://openrouter.ai/api/v1 \u00b7 Groq: https://api.groq.com/openai/v1')] : null,
        needsKey ? [h('label', { class: 'lbl' }, 'API key'), S.ai_key.from_env ? h('p', { class: 'small' }, 'Using the AI_API_KEY secret set on the Worker.') : key,
          h('div', { class: 'small muted', style: 'margin-top:4px' }, 'Stored on your server only, never sent to anyone\u2019s browser.'),
          S.ai_key.set && !S.ai_key.from_env ? h('button', { class: 'linkbtn', onclick: () => save({ ai_key: '' }) }, 'Remove saved key') : null] : null,
        c.ai.provider === 'workers-ai' ? h('p', { class: 'small muted', style: 'margin-top:6px' }, 'Uses the AI binding in wrangler.toml. Cloudflare\u2019s free tier covers a party easily.') : null,
        c.ai.provider !== 'none' ? h('button', { class: 'btn sm ghost', style: 'margin-top:12px', onclick: test }, 'Save & test') : null,
        aiResult ? h('div', { class: 'code', style: 'margin-top:10px' }, aiResult.pending ? 'Testing\u2026'
          : aiResult.ok ? `Works${aiResult.ms ? ` (${aiResult.ms} ms)` : ''}. ${aiResult.note || ''}${aiResult.groups ? 'Groups: ' + aiResult.groups.map((g) => '[' + g.join(', ') + ']').join(' ') + ' \u00b7 matches Pepperoni: ' + (aiResult.match.join(', ') || 'none') : ''}`
          : 'Didn\u2019t work: ' + aiResult.error) : null),
      h('div', { style: 'position:sticky;bottom:12px;margin-top:16px' },
        h('button', { class: 'btn block dark', onclick: () => save() }, 'Save settings')));
  }

  // ---------- players tab ----------
  function playersTab() {
    const nReg = S.prompt_count;
    return h('div', { class: 'card flat' },
      h('table', { class: 't' },
        h('tr', null, h('th', null, 'Name'), h('th', null, 'Answered'), h('th', null, 'Voted'), h('th', null, '')),
        S.players.map((p) => h('tr', null,
          h('td', null, p.name), h('td', null, `${p.answered}/${nReg}`), h('td', null, `${p.voted}/${S.vote_prompt_count}`),
          h('td', null,
            h('button', { class: 'linkbtn', onclick: () => relink(p) }, 'let back in'),
            h('button', { class: 'linkbtn', onclick: () => { if (confirm(`Remove ${p.name} and all their answers?`)) act({ action: 'kick', player_id: p.id }, 'Removed'); } }, 'remove'))))),
      S.players.length ? null : h('p', { class: 'muted' }, 'Nobody yet.'));
  }

  function render() {
    if (!token) { app.replaceChildren(loginView()); return; }
    if (!S) { app.replaceChildren(h('div', { class: 'wrap' }, 'Loading…')); return; }
    const tabs = h('div', { class: 'tabs' }, [['game', 'Game'], ['prompts', 'Questions'], ['players', `Players (${S.players.length})`], ['settings', 'Settings']].map(([k, l]) =>
      h('button', { class: tab === k ? 'on' : '', onclick: () => { if (tab === 'prompts' && dirty && !confirm('Discard unsaved question edits?')) return; if (k === 'prompts') startDraft(); if (k === 'settings') { sdraft = null; keyDraft = null; aiResult = null; } tab = k; render(); } }, l)));
    const body = tab === 'game' ? gameTab() : tab === 'prompts' ? promptsTab() : tab === 'settings' ? settingsTab() : playersTab();
    app.replaceChildren(h('div', { class: 'wrap' }, h('div', { class: 'topbar' }, h('div', { class: 'row' }, mascot(), h('strong', null, 'Host HQ'))), tabs, body), relinkInfo ? relinkModal() : '');
  }

  render();
  if (token) load(); else demoLogin().then((t) => { if (t) { token = t; load(); } });
  setInterval(() => {
    const a = document.activeElement;
    if (a && ['SELECT', 'INPUT', 'TEXTAREA'].includes(a.tagName)) return;
    if (!document.hidden && token && tab !== 'prompts' && tab !== 'settings' && !relinkInfo) load();
  }, 3000);
})();
