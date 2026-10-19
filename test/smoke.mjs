// End-to-end smoke test: plays a whole game against a running server.
//   npx wrangler dev            (in another terminal; needs ADMIN_PIN in .dev.vars)
//   npm test                    (or: BASE=http://localhost:8787 PIN=4242 node test/smoke.mjs)
// It RESETS the game on that server, so never point it at a real party.
const BASE = process.env.BASE || 'http://localhost:8787';
const PIN = process.env.PIN || '4242';

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; };
async function j(path, { body, headers } = {}) {
  const r = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', origin: BASE, ...(headers || {}) },
    body: body && JSON.stringify(body),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`${path}: ${t.error || r.status}`); e.status = r.status; throw e; }
  return t;
}

const { token: adm } = await j('/api/admin/login', { body: { pin: PIN } });
const A = { 'x-admin': adm };
const act = (b) => j('/api/admin/action', { body: b, headers: A });

console.log('setup');
let s = await act({ action: 'reset', confirm: 'RESET' });
s = await act({ action: 'settings', settings: { title: 'Smoke Test', host_name: 'Grandma', vote_seconds: 30, boosts: true, ai: { provider: 'none' } } });
ok(s.cfg.title === 'Smoke Test' && s.cfg.host_name === 'Grandma', 'settings saved');
const kinds = s.prompts.map((p) => p.kind);
ok(kinds.includes('mc') && kinds.includes('text') && kinds.includes('funny'), `has mc, text and funny questions (${kinds.join(',')})`);
// fill in host answers so every round can score
const prompts = s.prompts.map((p) => ({ ...p, host_answer: p.kind === 'mc' ? p.options[0] : p.kind === 'number' ? '7' : p.kind === 'text' ? 'Pizza' : null }));
s = await act({ action: 'prompts', prompts });
ok(s.prompts.filter((p) => p.kind === 'funny').every((p) => p.host_answer == null), 'funny rounds have no host answer');

console.log('answering');
s = await act({ action: 'bots' });
const me = await j('/api/join', { body: { name: 'Tester', code: s.join_code } });
const P = { 'x-player': me.token };
const twin = await j('/api/join', { body: { name: 'Tester', code: s.join_code } });
ok(twin.name === 'Tester 2', 'duplicate name becomes "Tester 2"');
let st = await j('/api/state', { headers: P });
ok(st.cfg && st.cfg.title === 'Smoke Test' && !('ai' in st.cfg), 'players get public settings only');
for (const p of st.prompts) {
  await j('/api/answer', { headers: P, body: { prompt_id: p.id, text: p.kind === 'mc' ? p.options[0] : p.kind === 'funny' ? 'A unicorn named Steve' : 'pizza' } });
}
const tv0 = await j('/api/admin/tv', { headers: A });
ok((await j('/api/admin/tv?v=' + tv0.key, { headers: A })).same === true, 'TV poll says "same" when nothing changed');

console.log('grouping');
s = await act({ action: 'phase', to: 'vote' });
const textP = s.prompts.find((p) => p.kind === 'text');
const grp = (s.groups[textP.id] || []).find((g) => g.answers.some((a) => a.name === 'Tester'));
ok(grp && grp.is_match, 'my "pizza" was grouped and pre-ticked as matching "Pizza"');

console.log('voting together');
s = await act({ action: 'phase', to: 'reveal' });
let checkedFunny = false, checkedHost = false;
for (let guard = 0; guard < 60 && s.phase === 'reveal'; guard++) {
  const tv = await j('/api/admin/tv', { headers: A });
  const sl = tv.slide;
  if (sl.step === 0 && (sl.prompt.kind === 'text' || sl.prompt.kind === 'funny')) {
    st = await j('/api/state', { headers: P });
    const opts = st.vote_options[sl.prompt.id];
    const mine = st.my.groups[sl.prompt.id];
    if (sl.prompt.kind === 'funny' && !checkedFunny) {
      let refused = false;
      try { await j('/api/vote', { headers: P, body: { prompt_id: sl.prompt.id, cluster_id: mine } }); } catch { refused = true; }
      ok(refused, 'funny round: voting for your own answer is refused');
      let noBoost = false;
      try { await j('/api/chip', { headers: P, body: { mult: 2, prompt_id: sl.prompt.id } }); } catch { noBoost = true; }
      ok(noBoost, 'funny round: boosts are refused');
      checkedFunny = true;
    }
    if (sl.prompt.kind === 'text' && !checkedHost) {
      await j('/api/chip', { headers: P, body: { mult: 2, prompt_id: sl.prompt.id } });
      checkedHost = true;
    }
    const pick = opts.find((o) => o.id !== mine) || opts[0];
    if (pick) await j('/api/vote', { headers: P, body: { prompt_id: sl.prompt.id, cluster_id: pick.id } });
    await act({ action: 'bots' });
  }
  if (sl.step === 1 && sl.prompt.kind === 'funny') ok(sl.host_answer == null && sl.options.every((o) => o.is_match == null), 'funny reveal shows no "right" answer');
  const last = sl.idx >= sl.total - 1 && sl.step === 2;
  s = await act(last ? { action: 'phase', to: 'final' } : { action: 'next', from: `${sl.idx}:${sl.step}` });
}
ok(checkedFunny && checkedHost, 'went through guess-the-host and funny rounds');

console.log('final');
ok(s.phase === 'final', 'final started');
st = await j('/api/state', { headers: P });
await j('/api/wager', { headers: P, body: { answer: '7', amount: st.final.max_wager } });
await act({ action: 'bots' });
s = await act({ action: 'phase', to: 'final_reveal' });
st = await j('/api/state', { headers: P });
ok(st.final.result && st.final.result.correct, 'exact number guess wins the final');
ok(st.leaderboard.length > 0 && typeof st.score === 'number', `leaderboard ready (my score ${st.score}, rank ${st.rank})`);

console.log('AI settings');
const t = await act({ action: 'ai_test' });
ok(t.ok, 'AI test with "none" reports built-in matching');
s = await act({ action: 'settings', settings: { ai: { provider: 'openai' } }, ai_key: 'sk-test-12345678' });
ok(s.ai_key.set && s.ai_key.hint === '…5678', 'API key saved and only its last 4 characters come back');
ok(!JSON.stringify(await j('/api/state', { headers: P })).includes('sk-test'), 'key never reaches a player');
await act({ action: 'settings', settings: { ai: { provider: 'none' } }, ai_key: '' });

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
