// Couchside: a phone + TV party game for homes and small groups. One Cloudflare Worker + D1.
// Phases: answer -> vote -> reveal -> final -> final_reveal
// Question kinds: mc (pick one), text (guess the host's answer), funny (funniest answer wins),
// number (final only: closest guess wins).
import { SCHEMA, seedStatements } from './schema.js';
import { aiGroup, aiTest, PROVIDER_IDS } from './ai.js';

const MAX_PLAYERS = 80;
// Each question on the TV has 3 steps: 0 = question up (text/funny: timed vote), 1 = reveal, 2 = leaderboard.
// Multiple choice has no timer: the host reveals with a click. Vote/final timers live in settings.
const GRACE_MS = 1500;     // late taps still count
const KINDS = ['mc', 'text', 'funny', 'number'];
const votable = (p) => !!p && (p.kind === 'text' || p.kind === 'funny');
const windowSecs = (p, cfg) => (votable(p) ? cfg.vote_seconds : 0);
const deadlineFor = (p, cfg) => (windowSecs(p, cfg) ? now() + windowSecs(p, cfg) * 1000 : null);
const FUNNY_VOTE_PTS = 2; // funny rounds: points for each vote your answer gets
// Final bet: up to half your score, but everyone can bet at least FINAL_FLOOR so trailing guests stay in it.
const FINAL_CAP = 0.5;
const FINAL_FLOOR = 20;
// Number final: an exact guess wins. If nobody is exact, the closest guess(es) win
// (ties all count, e.g. several people who guessed 8).
const NUMBER_TOLERANCE = 0;
const num = (v) => { const m = String(v == null ? '' : v).replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : NaN; };
function finalCorrectness(finalP, wagers) {
  const out = new Map();
  if (finalP.kind !== 'number') { for (const w of wagers) out.set(w.player_id, { correct: w.answer === finalP.host_answer, err: null }); return out; }
  const target = num(finalP.host_answer);
  const errs = wagers.map((w) => ({ id: w.player_id, err: Math.abs(num(w.answer) - target) })).filter((x) => Number.isFinite(x.err));
  const within = errs.some((x) => x.err <= NUMBER_TOLERANCE + 1e-9);
  const best = Math.min(...errs.map((x) => x.err));
  for (const w of wagers) {
    const e = errs.find((x) => x.id === w.player_id);
    const err = e ? e.err : null;
    const correct = err != null && (within ? err <= NUMBER_TOLERANCE + 1e-9 : Math.abs(err - best) < 1e-9);
    out.set(w.player_id, { correct, err });
  }
  return out;
}
const maxWager = (pre) => Math.max(FINAL_FLOOR, Math.floor(Math.max(0, pre || 0) * FINAL_CAP));
const PHASES = ['answer', 'vote', 'reveal', 'final', 'final_reveal'];

// ---------- helpers ----------
const SEC_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const J = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: SEC_HEADERS });
const E = (msg, status = 400) => J({ error: msg }, status);
class HttpError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const fail = (msg, status = 400) => { throw new HttpError(msg, status); };

const enc = new TextEncoder();
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', enc.encode(String(s)));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function randHex(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) {
  a = String(a); b = String(b);
  let r = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0;
}
function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
const now = () => Date.now();
const ip = (req) => req.headers.get('cf-connecting-ip') || 'local';

async function readBody(req) {
  const t = await req.text();
  if (t.length > 20000) fail('Too big', 413);
  if (!t) return {};
  try { return JSON.parse(t); } catch { fail('Bad JSON'); }
}

// fixed-window rate limit stored in D1
async function limited(env, key, max, windowSec) {
  const t = Math.floor(now() / 1000);
  const win = t - (t % windowSec);
  const r = await env.DB.prepare(
    'INSERT INTO rl (k, n, exp) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n'
  ).bind(`${key}:${win}`, win + windowSec).first();
  return r.n > max;
}

// ---------- settings ----------
// One JSON row (k='config') holds everything a host can customise in Admin -> Settings.
// The AI key is a separate row that never leaves the server (env.AI_API_KEY overrides it).
export const DEFAULT_CFG = {
  title: 'Couchside',
  subtitle: 'How well do you know the host?',
  host_name: 'the host',
  closes_text: '',
  photos: [],
  accent: '#FFCF33',
  vote_seconds: 45,
  final_seconds: 60,
  boosts: true,
  ai: { provider: 'none', model: '', base_url: '' },
};
function mergeCfg(raw) {
  let j = {};
  try { j = raw ? JSON.parse(raw) : {}; } catch {}
  return { ...DEFAULT_CFG, ...j, ai: { ...DEFAULT_CFG.ai, ...(j.ai || {}) } };
}
async function getCfg(env) {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k = 'config'").first();
  return mergeCfg(r && r.v);
}
async function getAiKey(env) {
  if (env.AI_API_KEY) return env.AI_API_KEY;
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k = 'ai_key'").first();
  return r ? r.v : '';
}
const publicCfg = (cfg, env) => { const { ai, ...rest } = cfg; return { ...rest, demo: isDemo(env) }; };
// Demo mode (env DEMO = "1", for a public try-it-out server): AI is locked off and a cron
// trigger resets everything hourly. See demo/README.md.
const isDemo = (env) => env && env.DEMO === '1';
const hostLabel = (cfg) => { const n = cfg.host_name || 'the host'; return n.charAt(0).toUpperCase() + n.slice(1); };

function validateCfg(input, cur) {
  const c = { ...cur, ai: { ...cur.ai } };
  const str = (k, max) => { if (input[k] !== undefined) c[k] = cleanText(String(input[k] ?? ''), max); };
  str('title', 40); str('subtitle', 80); str('host_name', 40); str('closes_text', 60);
  if (!c.title) c.title = DEFAULT_CFG.title;
  if (!c.host_name) c.host_name = DEFAULT_CFG.host_name;
  if (input.photos !== undefined) {
    const list = Array.isArray(input.photos) ? input.photos : String(input.photos).split(/\s+/);
    c.photos = list.map((u) => String(u).trim()).filter(Boolean).slice(0, 60).map((u) => {
      if (u.length > 300 || !/^https:\/\/[^\s"'<>]+$/i.test(u)) fail('Photo links must be https:// image URLs');
      return u;
    });
  }
  if (input.accent !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(input.accent)) fail('Accent colour must look like #FFCF33');
    c.accent = input.accent;
  }
  const int = (k, lo, hi) => { if (input[k] !== undefined) { const n = Math.round(Number(input[k])); if (!(n >= lo && n <= hi)) fail(`${k.replace('_', ' ')} must be ${lo}\u2013${hi}`); c[k] = n; } };
  int('vote_seconds', 10, 180); int('final_seconds', 20, 300);
  if (input.boosts !== undefined) c.boosts = !!input.boosts;
  if (input.ai) {
    const a = input.ai;
    if (a.provider !== undefined) { if (!PROVIDER_IDS.includes(a.provider)) fail('Unknown AI provider'); c.ai.provider = a.provider; }
    if (a.model !== undefined) c.ai.model = cleanText(String(a.model || ''), 120);
    if (a.base_url !== undefined) {
      const u = String(a.base_url || '').trim();
      if (u && !/^https?:\/\/[^\s"'<>]+$/i.test(u)) fail('Base URL must start with https://');
      c.ai.base_url = u.slice(0, 200);
    }
  }
  return c;
}

async function saveSettings(env, body) {
  if (isDemo(env)) { delete body.ai_key; if (body.settings) delete body.settings.ai; }
  const cur = await getCfg(env);
  const next = validateCfg(body.settings || {}, cur);
  const stmts = [env.DB.prepare("INSERT INTO settings (k, v) VALUES ('config', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(next))];
  if (typeof body.ai_key === 'string') {
    const k = body.ai_key.trim();
    if (k.length > 400) fail('That key is too long');
    stmts.push(k ? env.DB.prepare("INSERT INTO settings (k, v) VALUES ('ai_key', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k)
      : env.DB.prepare("DELETE FROM settings WHERE k = 'ai_key'"));
  }
  stmts.push(bump(env));
  await env.DB.batch(stmts);
}

// ---------- game row ----------
async function getGame(env) {
  let g = await env.DB.prepare('SELECT * FROM game WHERE id = 1').first();
  if (!g) {
    await env.DB.prepare('INSERT OR IGNORE INTO game (id, join_code) VALUES (1, ?)').bind(randHex(6)).run();
    g = await env.DB.prepare('SELECT * FROM game WHERE id = 1').first();
  }
  return g;
}
const bump = (env) => env.DB.prepare('UPDATE game SET ver = ver + 1 WHERE id = 1');
// Guest activity (join, answer, vote, boost, wager) doesn't change what phones show each other,
// so it bumps a separate counter. The TV and admin reload only when ver or act changes.
const bumpAct = (env) => env.DB.prepare('UPDATE game SET act = act + 1 WHERE id = 1');
const stateKey = (g) => `${g.ver}.${g.act || 0}`;

// ---------- auth ----------
async function playerFrom(req, env) {
  const tok = req.headers.get('x-player');
  if (!tok || tok.length > 100) return null;
  return env.DB.prepare('SELECT id, name FROM players WHERE token_hash = ?').bind(await sha256(tok)).first();
}
async function requirePlayer(req, env) {
  const p = await playerFrom(req, env);
  if (!p) fail('Not joined', 401);
  return p;
}
async function requireAdmin(req, env) {
  const tok = req.headers.get('x-admin');
  if (!tok || tok.length > 100) fail('Admin login required', 401);
  const s = await env.DB.prepare('SELECT exp FROM admin_sessions WHERE token_hash = ? AND exp > ?')
    .bind(await sha256(tok), now()).first();
  if (!s) fail('Admin login required', 401);
}

// ---------- data load + scoring ----------
async function loadAll(env) {
  const rs = await env.DB.batch([
    env.DB.prepare('SELECT * FROM prompts ORDER BY ord, id'),
    env.DB.prepare('SELECT id, name, created FROM players ORDER BY created, id'),
    env.DB.prepare('SELECT * FROM answers'),
    env.DB.prepare('SELECT * FROM clusters ORDER BY id'),
    env.DB.prepare('SELECT * FROM votes'),
    env.DB.prepare('SELECT * FROM chips'),
    env.DB.prepare('SELECT * FROM wagers'),
    env.DB.prepare("SELECT v FROM settings WHERE k = 'config'"),
  ]);
  const [prompts, players, answers, clusters, votes, chips, wagers, cfgRows] = rs.map((r) => r.results);
  const cfg = mergeCfg(cfgRows[0] && cfgRows[0].v);
  for (const p of prompts) p.options = p.options ? JSON.parse(p.options) : null;
  const regular = prompts.filter((p) => !p.is_final);
  const finalP = prompts.find((p) => p.is_final) || null;
  const k = (a, b) => `${a}:${b}`;
  const ansBy = new Map(answers.map((a) => [k(a.player_id, a.prompt_id), a]));
  const voteBy = new Map(votes.map((v) => [k(v.player_id, v.prompt_id), v]));
  const chipBy = new Map(chips.map((c) => [k(c.player_id, c.prompt_id), c.mult]));
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  const votersByCluster = new Map();
  for (const v of votes) {
    if (!votersByCluster.has(v.cluster_id)) votersByCluster.set(v.cluster_id, []);
    votersByCluster.get(v.cluster_id).push(v.player_id);
  }
  const membersByCluster = new Map();
  for (const a of answers) {
    if (a.cluster_id == null) continue;
    if (!membersByCluster.has(a.cluster_id)) membersByCluster.set(a.cluster_id, []);
    membersByCluster.get(a.cluster_id).push(a);
  }
  // Guess-the-host rounds: if no player wrote the host's answer (no ticked group), it goes into
  // the vote list like any other answer. Virtual group id = -prompt_id.
  for (const p of regular) {
    if (p.kind !== 'text' || !p.host_answer) continue;
    const guestMatch = clusters.some((c) => c.prompt_id === p.id && c.is_match && (membersByCluster.get(c.id) || []).length);
    if (guestMatch && !votersByCluster.has(-p.id)) continue;
    const label = p.host_answer.charAt(0).toUpperCase() + p.host_answer.slice(1);
    const c = { id: -p.id, prompt_id: p.id, label, is_match: 1, hosts: true };
    clusters.push(c);
    clusterById.set(c.id, c);
  }
  return { cfg, prompts, regular, finalP, players, answers, clusters, votes, chips, wagers, ansBy, voteBy, chipBy, clusterById, votersByCluster, membersByCluster, k };
}

function revealedCount(g, d) {
  if (['final', 'final_reveal'].includes(g.phase)) return d.regular.length;
  if (g.phase !== 'reveal') return 0;
  return Math.min(d.regular.length, g.reveal_idx + (g.reveal_step >= 2 ? 1 : 0));
}

// Points per regular prompt:
//  mc     +5 you picked the host's answer
//  text   +5 your answer matches the host's  ·  +1 per vote your answer gets from someone else
//         +2 you voted for the host's answer ·  +1 you voted for the most popular answer (ties count)
//  funny  +2 per vote your answer gets from someone else · +1 you voted for the crowd favourite
//  boost 2x/3x (text rounds only): multiplies only the +5 / +2 "right" points; if you got neither,
//         you lose 10 (2x) or 15 (3x). Points from votes received are never touched.
function scorePrompt(d, p, pl) {
  const key = d.k(pl.id, p.id);
  const a = d.ansBy.get(key);
  const v = d.voteBy.get(key);
  let matched = false, votePts = 0, correctVote = false, popularVote = false;
  if (p.kind === 'mc') {
    matched = !!(a && p.host_answer != null && a.text === p.host_answer);
  } else {
    if (a && a.cluster_id != null) {
      const c = d.clusterById.get(a.cluster_id);
      matched = p.kind === 'text' && !!(c && c.is_match);
      votePts = (d.votersByCluster.get(a.cluster_id) || []).filter((x) => x !== pl.id).length * (p.kind === 'funny' ? FUNNY_VOTE_PTS : 1);
    }
    if (v) {
      const c = d.clusterById.get(v.cluster_id);
      correctVote = p.kind === 'text' && !!(c && c.is_match);
      const counts = d.clusters.filter((x) => x.prompt_id === p.id).map((x) => (d.votersByCluster.get(x.id) || []).length);
      const top = Math.max(0, ...counts);
      popularVote = top > 0 && (d.votersByCluster.get(v.cluster_id) || []).length === top;
    }
  }
  // Boosts only touch the "got it right" points (+5 match, +2 right vote).
  // Votes your answer received and the crowd-pick point are never multiplied or lost.
  const rightPts = (matched ? 5 : 0) + (correctVote ? 2 : 0);
  const otherPts = votePts + (popularVote ? 1 : 0);
  const chip = p.kind === 'text' ? d.chipBy.get(key) || null : null;
  let pts = rightPts + otherPts;
  if (chip) pts = rightPts > 0 ? rightPts * chip + otherPts : otherPts - 5 * chip;
  return { prompt_id: p.id, matched, correctVote, popularVote, votePts, chip, pts, answered: !!a };
}

function computeScores(g, d) {
  const n = revealedCount(g, d);
  const totals = new Map(d.players.map((p) => [p.id, 0]));
  const breakdown = new Map(d.players.map((p) => [p.id, []]));
  for (let i = 0; i < n; i++) {
    const p = d.regular[i];
    for (const pl of d.players) {
      const s = scorePrompt(d, p, pl);
      totals.set(pl.id, totals.get(pl.id) + s.pts);
      breakdown.get(pl.id).push(s);
    }
  }
  const preFinal = new Map(totals);
  const finalResults = new Map();
  if (g.phase === 'final_reveal' && d.finalP) {
    const fc = finalCorrectness(d.finalP, d.wagers.filter((w) => totals.has(w.player_id)));
    for (const w of d.wagers) {
      if (!totals.has(w.player_id)) continue;
      const { correct, err } = fc.get(w.player_id);
      const delta = correct ? w.amount : -w.amount;
      totals.set(w.player_id, totals.get(w.player_id) + delta);
      finalResults.set(w.player_id, { answer: w.answer, amount: w.amount, correct, delta, err });
    }
  }
  const board = d.players
    .map((p) => ({ id: p.id, name: p.name, score: totals.get(p.id) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let rank = 0, last = null;
  board.forEach((r, i) => { if (r.score !== last) { rank = i + 1; last = r.score; } r.rank = rank; });
  return { n, totals, preFinal, breakdown, board, finalResults };
}

// What the current reveal slide shows (shared by player + TV)
function revealSlide(g, d, withNames) {
  if (g.phase !== 'reveal' || !d.regular.length) return null;
  const idx = Math.min(g.reveal_idx, d.regular.length - 1);
  const p = d.regular[idx];
  const step = g.reveal_step;
  // the TV shows the answer at step 1; phones only get it at step 2 so they can't spoil the reveal
  const shown = withNames ? step >= 1 : step >= 2;
  const name = new Map(d.players.map((x) => [x.id, x.name]));
  let options;
  if (p.kind === 'mc') {
    options = (p.options || []).map((o, i) => {
      const who = d.answers.filter((a) => a.prompt_id === p.id && a.text === o);
      return { letter: String.fromCharCode(65 + i), label: o, count: shown ? who.length : undefined, is_match: shown ? o === p.host_answer : undefined };
    });
  } else {
    // same order as the phones (voteOptions) so the letters match while voting
    options = (voteOptions(d)[p.id] || []).map((o, i) => {
      const c = d.clusterById.get(o.id);
      const members = d.membersByCluster.get(c.id) || [];
      return {
        letter: String.fromCharCode(65 + i),
        label: o.label,
        count: shown ? (d.votersByCluster.get(c.id) || []).length : undefined,
        written: members.length,
        authors: shown && withNames ? (c.hosts ? [hostLabel(d.cfg)] : members.map((a) => name.get(a.player_id) || '?')) : undefined,
        is_match: shown && p.kind === 'text' ? !!c.is_match : undefined,
        hosts: shown && c.hosts ? true : undefined,
      };
    });
    if (shown) options.sort((a, b) => b.count - a.count || b.written - a.written);
  }
  const slide = { idx, total: d.regular.length, step, prompt: { id: p.id, text: p.text, kind: p.kind }, options,
    first_text: d.cfg.boosts && d.regular.findIndex((x) => x.kind === 'text') === idx,
    deadline: step === 0 ? g.step_deadline : null, seconds: windowSecs(p, d.cfg) };
  if (shown && p.kind !== 'funny') slide.host_answer = p.host_answer;
  if (step === 0) slide.votes_in = votable(p) ? d.votes.filter((v) => v.prompt_id === p.id).length : null;
  if (withNames) {
    slide.chips = d.chips.filter((c) => c.prompt_id === p.id).map((c) => ({ name: name.get(c.player_id) || '?', mult: c.mult }))
      .sort((a, b) => b.mult - a.mult);
    if (step >= 2) {
      slide.results = d.players.map((pl) => ({ name: pl.name, ...scorePrompt(d, p, pl) }))
        .filter((r) => r.pts !== 0).sort((a, b) => b.pts - a.pts);
    }
  }
  return slide;
}

function voteOptions(d) {
  const out = {};
  for (const p of d.regular) {
    if (!votable(p)) continue;
    out[p.id] = d.clusters.filter((c) => c.prompt_id === p.id && (c.hosts || (d.membersByCluster.get(c.id) || []).length))
      .map((c) => ({ id: c.id, label: c.label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  return out;
}

// ---------- state views ----------
async function playerState(env, g, me) {
  const d = await loadAll(env);
  const sc = computeScores(g, d);
  const st = {
    ver: g.ver, phase: g.phase, joins_open: !!g.joins_open, server_now: now(),
    cfg: publicCfg(d.cfg, env),
    me: { id: me.id, name: me.name },
    prompts: d.regular.map((p) => ({ id: p.id, text: p.text, kind: p.kind, options: p.options })),
    my: { answers: {}, votes: {}, chips: {}, wager: null },
  };
  for (const a of d.answers) if (a.player_id === me.id) st.my.answers[a.prompt_id] = a.text;
  for (const v of d.votes) if (v.player_id === me.id) st.my.votes[v.prompt_id] = v.cluster_id;
  for (const c of d.chips) if (c.player_id === me.id) st.my.chips[c.mult] = c.prompt_id;
  const w = d.wagers.find((x) => x.player_id === me.id);
  if (w) st.my.wager = { answer: w.answer, amount: w.amount };
  if (g.phase !== 'answer') {
    st.vote_options = voteOptions(d);
    st.my.groups = {};
    for (const a of d.answers) if (a.player_id === me.id && a.cluster_id != null) st.my.groups[a.prompt_id] = a.cluster_id;
  }
  if (['reveal', 'final', 'final_reveal'].includes(g.phase)) {
    st.score = sc.totals.get(me.id) || 0;
    const row = sc.board.find((r) => r.id === me.id);
    st.rank = row ? row.rank : null;
    st.players = d.players.length;
    st.leaderboard = sc.board.slice(0, 5).map(({ name, score, rank }) => ({ name, score, rank }));
    st.revealed = (sc.breakdown.get(me.id) || []).map((b, i) => ({ ...b, text: d.regular[i].text, host_answer: d.regular[i].host_answer }));
  }
  if (g.phase === 'reveal') st.slide = revealSlide(g, d, false);
  if (g.phase === 'final' && d.finalP) {
    st.final = {
      prompt: { text: d.finalP.text, options: d.finalP.options, kind: d.finalP.kind },
      deadline: g.final_deadline,
      max_wager: maxWager(sc.preFinal.get(me.id)),
    };
  }
  if (g.phase === 'final_reveal' && d.finalP) {
    st.final = { prompt: { text: d.finalP.text, options: d.finalP.options, kind: d.finalP.kind }, host_answer: d.finalP.host_answer, result: sc.finalResults.get(me.id) || null };
  }
  return st;
}

function progress(d) {
  const votePrompts = d.regular.filter(votable).length;
  return d.players.map((pl) => {
    const answered = d.regular.filter((p) => d.ansBy.has(d.k(pl.id, p.id))).length;
    const voted = d.regular.filter((p) => votable(p) && d.voteBy.has(d.k(pl.id, p.id))).length;
    return { id: pl.id, name: pl.name, answered, voted, done_answering: answered >= d.regular.length, done_voting: voted >= votePrompts, wagered: d.wagers.some((w) => w.player_id === pl.id) };
  });
}

async function tvState(env, g, d) {
  d = d || await loadAll(env);
  const sc = computeScores(g, d);
  const st = {
    ver: g.ver, key: stateKey(g), phase: g.phase, join_code: g.join_code, joins_open: !!g.joins_open,
    cfg: publicCfg(d.cfg, env),
    prompt_count: d.regular.length,
    has_final: !!d.finalP,
    vote_prompt_count: d.regular.filter(votable).length,
    players: progress(d),
    server_now: now(),
  };
  if (['reveal', 'final', 'final_reveal'].includes(g.phase)) st.leaderboard = sc.board.map(({ name, score, rank }) => ({ name, score, rank }));
  if (g.phase === 'reveal') st.slide = revealSlide(g, d, true);
  if (g.phase === 'final' && d.finalP) st.final = { prompt: { text: d.finalP.text, options: d.finalP.options, kind: d.finalP.kind }, deadline: g.final_deadline, wagers_in: d.wagers.length };
  if (g.phase === 'final_reveal' && d.finalP) {
    const name = new Map(d.players.map((x) => [x.id, x.name]));
    st.final = {
      prompt: { text: d.finalP.text, options: d.finalP.options, kind: d.finalP.kind },
      host_answer: d.finalP.host_answer,
      wagers: [...sc.finalResults.entries()].map(([id, r]) => ({ name: name.get(id), ...r })).sort((a, b) => b.amount - a.amount),
    };
  }
  return st;
}

async function adminState(env, g) {
  const d = await loadAll(env);
  const base = await tvState(env, g, d); // one load, not two
  base.cfg = { ...d.cfg, demo: isDemo(env) }; // admin also sees the AI provider settings (never the key itself)
  const key = await getAiKey(env);
  base.ai_key = { set: !!key, hint: key ? '\u2026' + key.slice(-4) : '', from_env: !!env.AI_API_KEY };
  const st = await env.DB.prepare("SELECT v FROM settings WHERE k = 'ai_status'").first();
  base.ai_status = st ? JSON.parse(st.v) : null;
  const name = new Map(d.players.map((x) => [x.id, x.name]));
  base.prompts = d.prompts;
  base.reveal_idx = g.reveal_idx;
  base.reveal_step = g.reveal_step;
  base.groups = {};
  for (const p of d.regular) {
    if (!votable(p)) continue;
    base.groups[p.id] = d.clusters.filter((c) => c.prompt_id === p.id).map((c) => ({
      id: c.id, label: c.label, is_match: !!c.is_match,
      votes: (d.votersByCluster.get(c.id) || []).length,
      answers: (d.membersByCluster.get(c.id) || []).map((a) => ({ player_id: a.player_id, name: name.get(a.player_id), text: a.text })),
    })).filter((c) => c.answers.length);
  }
  base.raw_answers = {};
  for (const p of d.regular) {
    base.raw_answers[p.id] = d.answers.filter((a) => a.prompt_id === p.id).map((a) => ({ name: name.get(a.player_id), text: a.text }));
  }
  return base;
}

// ---------- clustering ----------
const STOP = new Set(['the', 'a', 'an', 'his', 'her', 'my', 'our', 'their', 'he', 'she', 'they', 'is', 'it', 'its', 'of', 'to', 'with', 'and', 'just', 'probably', 'definitely', 'maybe', 'some', 'little']);
function norm(s) {
  const out = s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]s\b/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ').trim();
  return out || s.toLowerCase().trim();
}
function pickLabel(items) {
  const counts = new Map();
  for (const a of items) {
    const t = a.text.trim().replace(/^(the|a|an|his|her|my|our|their)\s+/i, '') || a.text.trim();
    const k = t.toLowerCase();
    counts.set(k, { t, n: (counts.get(k)?.n || 0) + 1 });
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n || b.t.length - a.t.length)[0];
  return best.t.charAt(0).toUpperCase() + best.t.slice(1);
}
function looseMatch(label, target) {
  if (!target) return false;
  const a = label.toLowerCase().replace(/[^a-z0-9]/g, ''), b = target.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (a && a === b) return true;
  const A = stemWords(label), Bw = stemWords(target);
  if (!A.length || !Bw.length) return false;
  const [small, big] = A.length <= Bw.length ? [A, Bw] : [Bw, A];
  return small.join('').length >= 3 && small.every((w) => big.includes(w));
}

function stemWords(s) {
  return norm(s).split(' ').filter(Boolean).map((w) => (w.length > 4 && w.endsWith('ie') ? w.slice(0, -2) : w.length > 4 && w.endsWith('y') ? w.slice(0, -1) : w));
}
// Cheap grouping that works without AI: same letters ignoring punctuation/spaces,
// same normalized words, or one answer's words are a subset of another's ("pizza" vs "pepperoni pizza").
function heuristicGroups(answers) {
  const n = answers.length;
  const parent = answers.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const compact = answers.map((a) => a.text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, ''));
  const words = answers.map((a) => stemWords(a.text));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (compact[i] && compact[i] === compact[j]) { union(i, j); continue; }
    const A = words[i], Bw = words[j];
    if (!A.length || !Bw.length) continue;
    const key = (x) => x.join(' ');
    if (key(A) === key(Bw)) { union(i, j); continue; }
    const [small, big] = A.length <= Bw.length ? [A, Bw] : [Bw, A];
    if (small.join('').length >= 3 && small.every((w) => big.includes(w))) union(i, j);
  }
  const m = new Map();
  answers.forEach((a, i) => { const r = find(i); if (!m.has(r)) m.set(r, []); m.get(r).push(a); });
  return [...m.values()].sort((a, b) => b.length - a.length);
}

// Group one question's answers: built-in matching first, then the AI provider (if any) merges
// synonyms and suggests matches. AI errors never block the game: the built-in groups stand.
async function buildClusters(env, p, answers, cfg, key, status) {
  let groups = heuristicGroups(answers);
  const labels = groups.map(pickLabel);
  let matchIdx = null;
  let ai = null;
  if (p.kind === 'text' && labels.length) {
    try { ai = await aiGroup(env, cfg, key, { question: p.text, host_answer: p.host_answer, labels }); }
    catch (e) { status.errors.push(String(e && e.message || e).slice(0, 200)); }
  }
  if (ai) {
    groups = ai.groups.map((idxs) => idxs.flatMap((i) => groups[i]));
    matchIdx = ai.groups.map((idxs) => idxs.some((i) => ai.match.has(i)));
  }
  const stmts = [];
  const created = [];
  for (let i = 0; i < groups.length; i++) {
    const label = pickLabel(groups[i]);
    const isMatch = p.kind === 'text' && (matchIdx ? matchIdx[i] || looseMatch(label, p.host_answer) : looseMatch(label, p.host_answer));
    created.push({ label, isMatch, members: groups[i] });
  }
  for (const c of created) {
    const row = await env.DB.prepare('INSERT INTO clusters (prompt_id, label, is_match) VALUES (?, ?, ?) RETURNING id')
      .bind(p.id, c.label.slice(0, 80), c.isMatch ? 1 : 0).first();
    for (const a of c.members) {
      stmts.push(env.DB.prepare('UPDATE answers SET cluster_id = ? WHERE player_id = ? AND prompt_id = ?').bind(row.id, a.player_id, p.id));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}

async function clusterAll(env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM votes'),
    env.DB.prepare('DELETE FROM clusters'),
    env.DB.prepare('UPDATE answers SET cluster_id = NULL'),
  ]);
  const d = await loadAll(env);
  const key = await getAiKey(env);
  const status = { at: now(), provider: d.cfg.ai.provider, errors: [] };
  await Promise.all(d.regular.filter(votable).map((p) =>
    buildClusters(env, p, d.answers.filter((a) => a.prompt_id === p.id), d.cfg, key, status)));
  status.ok = !status.errors.length;
  status.errors = [...new Set(status.errors)].slice(0, 3);
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('ai_status', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(status)).run();
}

async function cleanupEmptyClusters(env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM votes WHERE cluster_id > 0 AND cluster_id NOT IN (SELECT DISTINCT cluster_id FROM answers WHERE cluster_id IS NOT NULL)'),
    env.DB.prepare('DELETE FROM clusters WHERE id NOT IN (SELECT DISTINCT cluster_id FROM answers WHERE cluster_id IS NOT NULL)'),
  ]);
}

// ---------- player actions ----------
async function join(req, env, g) {
  const body = await readBody(req);
  if (await limited(env, 'join:' + ip(req), 200, 600)) fail('Slow down', 429);
  if (!g.joins_open) fail('Joining is closed');
  if (!safeEq(String(body.code || ''), g.join_code)) fail('Scan the QR code on the TV to join', 403);
  const name = cleanText(body.name, 20);
  if (name.length < 1) fail('Enter a name');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM players').first();
  if (count.n >= MAX_PLAYERS) fail('Game is full');
  const tok = randHex(24);
  const hash = await sha256(tok);
  // Duplicate names are fine: the second Grandma becomes "Grandma 2"
  for (let n = 1; n <= 50; n++) {
    const nm = n === 1 ? name : `${name.slice(0, 17)} ${n}`;
    try {
      const r = await env.DB.prepare('INSERT INTO players (name, name_key, token_hash, created) VALUES (?, ?, ?, ?) RETURNING id')
        .bind(nm, nm.toLowerCase(), hash, now()).first();
      await bumpAct(env).run();
      return J({ token: tok, id: r.id, name: nm });
    } catch (e) {
      if (!String(e).includes('UNIQUE')) throw e;
    }
  }
  fail('Too many people with that name!');
}

async function getPrompt(env, id) {
  const p = await env.DB.prepare('SELECT * FROM prompts WHERE id = ?').bind(Number(id) || 0).first();
  if (!p) fail('Unknown question');
  p.options = p.options ? JSON.parse(p.options) : null;
  return p;
}

async function answer(req, env, g, me) {
  const body = await readBody(req);
  if (g.phase !== 'answer') fail('Answers are locked');
  const p = await getPrompt(env, body.prompt_id);
  if (p.is_final) fail('Not yet!');
  let text = cleanText(body.text, 60);
  if (!text) fail('Write an answer');
  if (p.kind === 'mc' && !(p.options || []).includes(text)) fail('Pick one of the options');
  await env.DB.prepare('INSERT INTO answers (player_id, prompt_id, text) VALUES (?, ?, ?) ON CONFLICT(player_id, prompt_id) DO UPDATE SET text = excluded.text')
    .bind(me.id, p.id, text).run();
  return null;
}

async function vote(req, env, g, me) {
  const body = await readBody(req);
  const p = await getPrompt(env, body.prompt_id);
  await requireLiveWindow(env, g, p);
  if (!votable(p) || p.is_final) fail('No voting on this one');
  const cid = Number(body.cluster_id) || 0;
  if (p.kind === 'funny') {
    const mine = await env.DB.prepare('SELECT cluster_id FROM answers WHERE player_id = ? AND prompt_id = ?').bind(me.id, p.id).first();
    if (mine && mine.cluster_id === cid) fail('No voting for your own answer!');
  }
  const c = cid < 0
    ? ((voteOptions(await loadAll(env))[p.id] || []).some((o) => o.id === cid) ? { id: cid } : null)
    : await env.DB.prepare('SELECT id FROM clusters WHERE id = ? AND prompt_id = ?').bind(cid, p.id).first();
  if (!c) fail('Unknown option');
  await env.DB.prepare('INSERT INTO votes (player_id, prompt_id, cluster_id) VALUES (?, ?, ?) ON CONFLICT(player_id, prompt_id) DO UPDATE SET cluster_id = excluded.cluster_id')
    .bind(me.id, p.id, c.id).run();
  return null;
}

async function chip(req, env, g, me) {
  const body = await readBody(req);
  const mult = Number(body.mult);
  if (mult !== 2 && mult !== 3) fail('Bad bet');
  if (!(await getCfg(env)).boosts) fail('Boosts are turned off for this game');
  const cur = await currentPrompt(env, g);
  const existing = await env.DB.prepare('SELECT prompt_id FROM chips WHERE player_id = ? AND mult = ?').bind(me.id, mult).first();
  // a boost used on an earlier question stays there
  if (existing && (!cur || existing.prompt_id !== cur.id)) fail(`You already used your ${mult}\u00d7 boost`);
  if (body.prompt_id == null) {
    if (cur) await requireLiveWindow(env, g, cur);
    await env.DB.prepare('DELETE FROM chips WHERE player_id = ? AND mult = ?').bind(me.id, mult).run();
    return null;
  }
  const p = await getPrompt(env, body.prompt_id);
  await requireLiveWindow(env, g, p);
  if (p.is_final) fail('No bets on the final');
  if (p.kind !== 'text') fail('Boosts only work on guess-the-host questions');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chips WHERE player_id = ? AND prompt_id = ? AND mult != ?').bind(me.id, p.id, mult),
    env.DB.prepare('INSERT INTO chips (player_id, mult, prompt_id) VALUES (?, ?, ?) ON CONFLICT(player_id, mult) DO UPDATE SET prompt_id = excluded.prompt_id').bind(me.id, mult, p.id),
  ]);
  return null;
}

async function currentPrompt(env, g) {
  if (g.phase !== 'reveal') return null;
  const reg = (await env.DB.prepare('SELECT id, kind FROM prompts WHERE is_final = 0 ORDER BY ord, id').all()).results;
  return reg[Math.min(g.reveal_idx, reg.length - 1)] || null;
}
async function requireLiveWindow(env, g, p) {
  if (g.phase !== 'reveal' || g.reveal_step !== 0) fail('Voting happens together on the TV');
  if (!votable(p)) fail('No voting on the multiple choice questions');
  const cur = await currentPrompt(env, g);
  if (!cur || cur.id !== p.id) fail('That question isn\u2019t up on the TV right now');
  if (g.step_deadline && now() > g.step_deadline + GRACE_MS) fail('Time\u2019s up!');
}

async function wager(req, env, g, me) {
  const body = await readBody(req);
  if (g.phase !== 'final') fail('The final is not open');
  if (!g.final_deadline || now() > g.final_deadline + 2000) fail('Time is up!');
  const d = await loadAll(env);
  if (!d.finalP) fail('No final question');
  let ans = cleanText(body.answer, 60);
  if (d.finalP.kind === 'number') {
    const n = num(ans);
    if (!Number.isFinite(n) || n < 0 || n > 1000) fail('Type a number');
    ans = String(n);
  } else if (!(d.finalP.options || []).includes(ans)) fail('Pick an answer');
  const sc = computeScores(g, d);
  const max = maxWager(sc.preFinal.get(me.id));
  const amount = Math.floor(Number(body.amount));
  if (!Number.isFinite(amount) || amount < 0 || amount > max) fail(`Bet between 0 and ${max}`);
  await env.DB.prepare('INSERT INTO wagers (player_id, answer, amount) VALUES (?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET answer = excluded.answer, amount = excluded.amount')
    .bind(me.id, ans, amount).run();
  return null;
}

// ---------- admin actions ----------
async function adminLogin(req, env) {
  const body = await readBody(req);
  if (isDemo(env)) return J({ token: await newAdminSession(env) }); // demo server: no PIN
  if (!env.ADMIN_PIN || String(env.ADMIN_PIN).length < 4) fail('Set an ADMIN_PIN secret first: Cloudflare dashboard → Workers → couchside → Settings → Variables and secrets (or: npx wrangler secret put ADMIN_PIN)', 503);
  if (await limited(env, 'pin:' + ip(req), 10, 600)) fail('Too many tries. Wait 10 minutes.', 429);
  const ok = safeEq(await sha256(String(body.pin || '')), await sha256(String(env.ADMIN_PIN)));
  if (!ok) fail('Wrong PIN', 403);
  return J({ token: await newAdminSession(env) });
}
async function newAdminSession(env) {
  const tok = randHex(24);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE exp < ?').bind(now()),
    env.DB.prepare('DELETE FROM rl WHERE exp < ?').bind(Math.floor(now() / 1000)),
    env.DB.prepare('INSERT INTO admin_sessions (token_hash, exp) VALUES (?, ?)').bind(await sha256(tok), now() + 36 * 3600 * 1000),
  ]);
  return tok;
}

async function savePrompts(env, body, g) {
  if (!Array.isArray(body.prompts) || body.prompts.length > 30) fail('Up to 30 questions');
  const list = body.prompts.map((p, i) => {
    const kind = KINDS.includes(p.kind) ? p.kind : 'text';
    if (kind === 'number' && !p.is_final) fail(`Question ${i + 1}: number answers are only for the final`);
    if (kind === 'number' && p.host_answer && !Number.isFinite(num(p.host_answer))) fail(`Question ${i + 1}: the host\u2019s answer must be a number`);
    const text = cleanText(p.text, 160);
    if (!text) fail(`Question ${i + 1} is empty`);
    let options = null;
    if (kind === 'mc') {
      options = (Array.isArray(p.options) ? p.options : []).map((o) => cleanText(o, 40)).filter(Boolean);
      options = [...new Set(options)];
      if (options.length < 2 || options.length > 6) fail(`Question ${i + 1} needs 2–6 options`);
    }
    let pa = kind === 'funny' ? null : cleanText(p.host_answer || '', 60) || null;
    if (kind === 'mc' && pa && !options.includes(pa)) fail(`Question ${i + 1}: the host's answer must be one of the options`);
    if (kind === 'funny' && p.is_final) fail(`Question ${i + 1}: a funny round can't be the final`);
    return { id: Number(p.id) || null, ord: i + 1, text, kind, options, host_answer: pa, is_final: p.is_final ? 1 : 0 };
  });
  const finals = list.filter((p) => p.is_final);
  if (finals.length > 1) fail('Only one final question');
  if (finals.length && !['mc', 'number'].includes(finals[0].kind)) fail('The final question must be multiple choice or a number');
  const existing = (await env.DB.prepare('SELECT id, kind FROM prompts').all()).results;
  const exIds = new Set(existing.map((e) => e.id));
  const keep = new Set(list.filter((p) => p.id && exIds.has(p.id)).map((p) => p.id));
  if (g.phase !== 'answer') {
    // after answering closes only allow editing wording and host answers; structure is frozen
    if (keep.size !== existing.length || list.some((p) => !p.id || !exIds.has(p.id))) fail('Questions can only be added/removed during the answer phase');
    for (const p of list) if (existing.find((e) => e.id === p.id).kind !== p.kind) fail('Can’t change question type after answering closes');
  }
  const stmts = [];
  for (const e of existing) {
    if (keep.has(e.id)) continue;
    for (const t of ['answers', 'votes', 'chips', 'clusters']) stmts.push(env.DB.prepare(`DELETE FROM ${t} WHERE prompt_id = ?`).bind(e.id));
    stmts.push(env.DB.prepare('DELETE FROM prompts WHERE id = ?').bind(e.id));
  }
  for (const p of list) {
    const opts = p.options ? JSON.stringify(p.options) : null;
    if (p.id && keep.has(p.id)) {
      stmts.push(env.DB.prepare('UPDATE prompts SET ord = ?, text = ?, kind = ?, options = ?, host_answer = ?, is_final = ? WHERE id = ?')
        .bind(p.ord, p.text, p.kind, opts, p.host_answer, p.is_final, p.id));
    } else {
      stmts.push(env.DB.prepare('INSERT INTO prompts (ord, text, kind, options, host_answer, is_final) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(p.ord, p.text, p.kind, opts, p.host_answer, p.is_final));
    }
  }
  // drop mc answers that no longer match an option
  stmts.push(bump(env));
  await env.DB.batch(stmts);
  const mcs = (await env.DB.prepare("SELECT id, options FROM prompts WHERE kind = 'mc'").all()).results;
  for (const m of mcs) {
    const opts = JSON.parse(m.options || '[]');
    const ph = opts.map(() => '?').join(',');
    if (opts.length) await env.DB.prepare(`DELETE FROM answers WHERE prompt_id = ? AND text NOT IN (${ph})`).bind(m.id, ...opts).run();
  }
}

async function setPhase(env, g, to) {
  if (!PHASES.includes(to)) fail('Bad phase');
  const d = await loadAll(env);
  if (to === 'vote' && g.phase === 'answer') await clusterAll(env);
  if (to === 'answer') {
    await env.DB.batch([env.DB.prepare('DELETE FROM votes'), env.DB.prepare('DELETE FROM chips'), env.DB.prepare('DELETE FROM clusters'), env.DB.prepare('UPDATE answers SET cluster_id = NULL')]);
  }
  if (to === 'final' && !d.finalP) fail('No final question set up');
  if (to === 'final' && d.finalP.kind === 'number' && !Number.isFinite(num(d.finalP.host_answer))) fail('The final\u2019s answer must be a number');
  if (to === 'final' && !d.finalP.host_answer) fail('Set the host’s answer for the final question first');
  if (to === 'reveal' && !d.regular.length) fail('No questions');
  const stmts = [];
  if (to === 'reveal' && g.phase === 'vote') stmts.push(env.DB.prepare('UPDATE game SET reveal_idx = 0, reveal_step = 0, step_deadline = ? WHERE id = 1').bind(deadlineFor(d.regular[0], d.cfg)));
  if (to === 'final') stmts.push(env.DB.prepare('UPDATE game SET final_deadline = ? WHERE id = 1').bind(now() + d.cfg.final_seconds * 1000 + 1500));
  stmts.push(env.DB.prepare('UPDATE game SET phase = ? WHERE id = 1').bind(to));
  stmts.push(bump(env));
  await env.DB.batch(stmts);
}

async function revealStep(env, g, dir, from) {
  if (g.phase !== 'reveal') fail('Not revealing');
  // the TV auto-advances when the timer ends; `from` makes a duplicate tap (TV + phone) harmless
  if (from != null && from !== `${g.reveal_idx}:${g.reveal_step}`) return;
  const reg = (await env.DB.prepare('SELECT id, kind FROM prompts WHERE is_final = 0 ORDER BY ord, id').all()).results;
  const n = reg.length;
  let { reveal_idx: i, reveal_step: s } = g;
  if (dir > 0) { if (s < 2) s++; else if (i < n - 1) { i++; s = 0; } }
  else { if (s > 0) s--; else if (i > 0) { i--; s = 2; } }
  const deadline = s === 0 ? deadlineFor(reg[i], await getCfg(env)) : null;
  await env.DB.batch([env.DB.prepare('UPDATE game SET reveal_idx = ?, reveal_step = ?, step_deadline = ? WHERE id = 1').bind(i, s, deadline), bump(env)]);
}

async function adminAction(env, g, body) {
  switch (body.action) {
    case 'phase': await setPhase(env, g, body.to); break;
    case 'next': await revealStep(env, g, 1, body.from); break;
    case 'prev': await revealStep(env, g, -1); break;
    case 'prompts': await savePrompts(env, body, g); break;
    case 'match': {
      await env.DB.batch([env.DB.prepare('UPDATE clusters SET is_match = ? WHERE id = ?').bind(body.is_match ? 1 : 0, Number(body.cluster_id) || 0), bump(env)]);
      break;
    }
    case 'merge': {
      const a = await env.DB.prepare('SELECT * FROM clusters WHERE id = ?').bind(Number(body.from) || 0).first();
      const b = await env.DB.prepare('SELECT * FROM clusters WHERE id = ?').bind(Number(body.to) || 0).first();
      if (!a || !b || a.prompt_id !== b.prompt_id || a.id === b.id) fail('Bad merge');
      await env.DB.batch([
        env.DB.prepare('UPDATE answers SET cluster_id = ? WHERE cluster_id = ?').bind(b.id, a.id),
        env.DB.prepare('UPDATE votes SET cluster_id = ? WHERE cluster_id = ?').bind(b.id, a.id),
        env.DB.prepare('UPDATE clusters SET is_match = MAX(is_match, ?) WHERE id = ?').bind(a.is_match, b.id),
        env.DB.prepare('DELETE FROM clusters WHERE id = ?').bind(a.id),
        bump(env),
      ]);
      break;
    }
    case 'split': {
      // move one answer into its own new group
      const a = await env.DB.prepare('SELECT * FROM answers WHERE player_id = ? AND prompt_id = ?').bind(Number(body.player_id) || 0, Number(body.prompt_id) || 0).first();
      if (!a) fail('No such answer');
      const label = a.text.charAt(0).toUpperCase() + a.text.slice(1);
      const c = await env.DB.prepare('INSERT INTO clusters (prompt_id, label, is_match) VALUES (?, ?, 0) RETURNING id').bind(a.prompt_id, label.slice(0, 80)).first();
      await env.DB.prepare('UPDATE answers SET cluster_id = ? WHERE player_id = ? AND prompt_id = ?').bind(c.id, a.player_id, a.prompt_id).run();
      await cleanupEmptyClusters(env);
      await bump(env).run();
      break;
    }
    case 'rename': {
      const label = cleanText(body.label, 80);
      if (!label) fail('Empty label');
      await env.DB.batch([env.DB.prepare('UPDATE clusters SET label = ? WHERE id = ?').bind(label, Number(body.cluster_id) || 0), bump(env)]);
      break;
    }
    case 'regroup': {
      if (g.phase !== 'vote') fail('Only before TV voting starts');
      await clusterAll(env);
      await bump(env).run();
      break;
    }
    case 'kick': {
      const id = Number(body.player_id) || 0;
      await env.DB.batch(['answers', 'votes', 'chips', 'wagers'].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE player_id = ?`).bind(id))
        .concat([env.DB.prepare('DELETE FROM players WHERE id = ?').bind(id)]));
      await cleanupEmptyClusters(env);
      await bump(env).run();
      break;
    }
    case 'joins': await env.DB.batch([env.DB.prepare('UPDATE game SET joins_open = ? WHERE id = 1').bind(body.open ? 1 : 0), bump(env)]); break;
    case 'rotate_code': await env.DB.batch([env.DB.prepare('UPDATE game SET join_code = ? WHERE id = 1').bind(randHex(6)), bump(env)]); break;
    case 'extend': {
      if (g.phase === 'reveal' && g.reveal_step === 0 && g.step_deadline) {
        await env.DB.batch([env.DB.prepare('UPDATE game SET step_deadline = ? WHERE id = 1').bind(Math.max(g.step_deadline || 0, now()) + 10000), bump(env)]);
        break;
      }
      if (g.phase !== 'final') fail('Final not running');
      await env.DB.batch([env.DB.prepare('UPDATE game SET final_deadline = ? WHERE id = 1').bind(Math.max(g.final_deadline || 0, now()) + 20000), bump(env)]);
      break;
    }
    case 'bots': await runBots(env, g); break;
    case 'settings': await saveSettings(env, body); break;
    case 'reset': {
      if (body.confirm !== 'RESET') fail('Type RESET to confirm');
      await env.DB.batch([
        ...['answers', 'votes', 'chips', 'wagers', 'clusters', 'players'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
        env.DB.prepare("UPDATE game SET phase = 'answer', reveal_idx = 0, reveal_step = 0, final_deadline = NULL, joins_open = 1 WHERE id = 1"), // keeps the join code so printed posters still work
        bump(env),
      ]);
      break;
    }
    default: fail('Unknown action');
  }
}

// ---------- test players ("bots") ----------
// Lets the hosts rehearse alone: one admin button does whatever the current phase needs.
// Bots are normal player rows whose token is never handed out, so nobody can act as them.
// Reset game removes them like any other player.
const BOT_NAMES = ['Test Grandma', 'Test Auntie', 'Test Uncle', 'Test Billy', 'Test Friend'];
const BOT_SKILL = [0.8, 0.5, 0.5, 0.15, 0.35]; // chance of knowing the host's answer
const SILLY = ['Pizza', 'The dog', 'Sleeping in', 'Tacos', 'Karaoke', 'Their phone', 'Coffee', 'Board games', 'Netflix', 'Snacks', 'Nap time', 'Dancing', 'A llama', 'Socks with sandals', 'Glitter'];
const pickR = (a) => a[Math.floor(Math.random() * a.length)];

async function runBots(env, g) {
  const ensure = async () => {
    for (const name of BOT_NAMES) {
      await env.DB.prepare('INSERT OR IGNORE INTO players (name, name_key, token_hash, created) VALUES (?, ?, ?, ?)')
        .bind(name, name.toLowerCase(), 'bot-' + randHex(16), now()).run();
    }
    const d = await loadAll(env);
    return { d, bots: d.players.filter((p) => BOT_NAMES.includes(p.name)) };
  };
  const skill = (name) => BOT_SKILL[BOT_NAMES.indexOf(name)] ?? 0.4;
  const stmts = [];
  if (g.phase === 'answer') {
    const { d, bots } = await ensure();
    for (const b of bots) {
      for (const p of d.regular) {
        const knows = Math.random() < skill(b.name);
        let text;
        if (p.kind === 'mc') text = knows && p.host_answer ? p.host_answer : pickR(p.options || ['?']);
        else text = knows && p.host_answer ? (Math.random() < 0.5 ? p.host_answer.toLowerCase() : p.host_answer) : pickR(SILLY);
        stmts.push(env.DB.prepare('INSERT INTO answers (player_id, prompt_id, text) VALUES (?, ?, ?) ON CONFLICT(player_id, prompt_id) DO UPDATE SET text = excluded.text').bind(b.id, p.id, text.slice(0, 60)));
      }
    }
  } else if (g.phase === 'reveal' && g.reveal_step === 0) {
    // vote on the question that's up on the TV right now, and maybe use a boost on it
    const d = await loadAll(env);
    const p = d.regular[Math.min(g.reveal_idx, d.regular.length - 1)];
    const opts = voteOptions(d)[p.id] || [];
    for (const b of d.players.filter((x) => BOT_NAMES.includes(x.name))) {
      if (votable(p) && opts.length) {
        const own = (d.ansBy.get(d.k(b.id, p.id)) || {}).cluster_id;
        const allowed = p.kind === 'funny' ? opts.filter((o) => o.id !== own) : opts;
        if (!allowed.length) continue;
        const matches = allowed.filter((o) => d.clusterById.get(o.id).is_match);
        const c = p.kind === 'text' && Math.random() < skill(b.name) && matches.length ? pickR(matches) : pickR(allowed);
        stmts.push(env.DB.prepare('INSERT INTO votes (player_id, prompt_id, cluster_id) VALUES (?, ?, ?) ON CONFLICT(player_id, prompt_id) DO UPDATE SET cluster_id = excluded.cluster_id').bind(b.id, p.id, c.id));
      }
      for (const mult of (p.kind === 'text' && d.cfg.boosts ? [3, 2] : [])) {
        const used = d.chips.some((c) => c.player_id === b.id && (c.mult === mult || c.prompt_id === p.id));
        if (!used && Math.random() < 0.25) { stmts.push(env.DB.prepare('INSERT OR REPLACE INTO chips (player_id, mult, prompt_id) VALUES (?, ?, ?)').bind(b.id, mult, p.id)); break; }
      }
    }
  } else if (g.phase === 'final') {
    const d = await loadAll(env);
    if (!d.finalP) fail('No final question');
    const sc = computeScores(g, d);
    for (const b of d.players.filter((p) => BOT_NAMES.includes(p.name))) {
      const max = maxWager(sc.preFinal.get(b.id));
      const ans = d.finalP.kind === 'number'
        ? String(Math.round((num(d.finalP.host_answer) + (Math.random() - 0.5) * (4 - 3 * skill(b.name))) * 10) / 10)
        : Math.random() < skill(b.name) * 0.7 ? d.finalP.host_answer : pickR(d.finalP.options || []);
      const amount = pickR([0, Math.floor(max / 2), max]);
      stmts.push(env.DB.prepare('INSERT OR REPLACE INTO wagers (player_id, answer, amount) VALUES (?, ?, ?)').bind(b.id, ans, amount));
    }
  } else {
    fail(g.phase === 'vote' ? 'Test players vote once TV voting starts' : 'Nothing for test players to do right now');
  }
  stmts.push(bump(env));
  await env.DB.batch(stmts);
}

// ---------- router ----------
async function api(req, env, url) {
  const path = url.pathname;
  const method = req.method;
  if (method === 'POST') {
    const origin = req.headers.get('origin');
    if (origin && new URL(origin).host !== url.host) fail('Bad origin', 403);
  }
  const g = await getGame(env);

  if (path === '/api/join' && method === 'POST') return join(req, env, g);

  if (path === '/api/state' && method === 'GET') {
    const me = await playerFrom(req, env);
    if (!me) return J({ ver: g.ver, phase: g.phase, joins_open: !!g.joins_open, joined: false, cfg: publicCfg(await getCfg(env), env), join_code: isDemo(env) ? g.join_code : undefined });
    if (url.searchParams.get('v') === String(g.ver)) return J({ same: true, ver: g.ver });
    return J(await playerState(env, g, me));
  }

  const playerActions = { '/api/answer': answer, '/api/vote': vote, '/api/chip': chip, '/api/wager': wager };
  if (playerActions[path] && method === 'POST') {
    const me = await requirePlayer(req, env);
    if (await limited(env, 'act:' + me.id, 120, 60)) fail('Slow down', 429);
    await playerActions[path](req, env, g, me);
    await bumpAct(env).run();
    const g2 = await getGame(env);
    return J(await playerState(env, g2, me));
  }

  if (path === '/api/admin/login' && method === 'POST') return adminLogin(req, env);
  if (path === '/api/info' && method === 'GET') return J({ demo: isDemo(env) });

  if (path.startsWith('/api/admin/')) {
    await requireAdmin(req, env);
    // ?v=<key> from the last full state: reply "same" (2 row reads) unless something changed
    if (method === 'GET' && url.searchParams.get('v') === stateKey(g) && (path === '/api/admin/state' || path === '/api/admin/tv')) return J({ same: true, key: stateKey(g) });
    if (path === '/api/admin/state' && method === 'GET') return J(await adminState(env, g));
    if (path === '/api/admin/tv' && method === 'GET') return J(await tvState(env, g));
    if (path === '/api/admin/action' && method === 'POST') {
      const body = await readBody(req);
      if (body.action === 'ai_test' && isDemo(env)) return J({ ok: false, error: 'AI is turned off on the demo server. Deploy your own copy to try it.' });
      if (body.action === 'ai_test') {
        try { return J(await aiTest(env, (await getCfg(env)), await getAiKey(env))); }
        catch (e) { return J({ ok: false, error: String(e && e.message || e).slice(0, 300) }); }
      }
      if (body.action === 'relink') {
        // host-assisted rejoin: issue a fresh link for one player (old phone/browser is logged out)
        const id = Number(body.player_id) || 0;
        const tok = randHex(24);
        const r = await env.DB.prepare('UPDATE players SET token_hash = ? WHERE id = ? RETURNING name').bind(await sha256(tok), id).first();
        if (!r) fail('No such player');
        return J({ token: tok, name: r.name, join_code: g.join_code });
      }
      await adminAction(env, g, body);
      return J(await adminState(env, await getGame(env)));
    }
  }
  fail('Not found', 404);
}

// Create tables (and starter questions) on the first request after a deploy.
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch([...SCHEMA.map((q) => env.DB.prepare(q)), ...seedStatements(env.DB)])
      .catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// Demo server: wipe players, answers, settings and questions back to the starter pack.
async function demoReset(env) {
  await ensureSchema(env);
  await env.DB.batch([
    ...['answers', 'votes', 'chips', 'wagers', 'clusters', 'players', 'prompts', 'admin_sessions', 'rl'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare('DELETE FROM settings'),
    env.DB.prepare("UPDATE game SET phase = 'answer', reveal_idx = 0, reveal_step = 0, final_deadline = NULL, step_deadline = NULL, joins_open = 1 WHERE id = 1"),
    ...seedStatements(env.DB),
    bump(env),
  ]);
}

export default {
  async scheduled(event, env, ctx) {
    if (isDemo(env)) ctx.waitUntil(demoReset(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      await ensureSchema(env);
      return await api(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return E(e.message, e.status);
      console.error(e && e.stack || e);
      return E('Something went wrong', 500);
    }
  },
};
