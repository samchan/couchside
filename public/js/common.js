// Shared helpers. All user-provided text goes through text nodes (never innerHTML).
const $ = (s, r = document) => r.querySelector(s);

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

// Couch mascot (static, trusted markup). Uses the theme accent colour.
const MASCOT_SVG = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
  + '<rect x="18" y="26" width="64" height="34" rx="12" fill="var(--accent)" stroke="#34302B" stroke-width="4"/>'
  + '<rect x="6" y="44" width="20" height="30" rx="9" fill="var(--accent)" stroke="#34302B" stroke-width="4"/>'
  + '<rect x="74" y="44" width="20" height="30" rx="9" fill="var(--accent)" stroke="#34302B" stroke-width="4"/>'
  + '<rect x="24" y="54" width="52" height="18" rx="6" fill="#FFFDF8" stroke="#34302B" stroke-width="4"/>'
  + '<path d="M50 56v14" stroke="#34302B" stroke-width="3"/>'
  + '<path d="M16 74v8M84 74v8" stroke="#34302B" stroke-width="5" stroke-linecap="round"/>'
  + '<circle cx="38" cy="40" r="3" fill="#34302B"/><circle cx="62" cy="40" r="3" fill="#34302B"/>'
  + '<path d="M42 47c4 4 12 4 16 0" fill="none" stroke="#34302B" stroke-width="3" stroke-linecap="round"/>'
  + '</svg>';
function mascot(cls) {
  const s = document.createElement('span');
  s.className = 'mascot ' + (cls || '');
  s.innerHTML = MASCOT_SVG;
  return s;
}

// Host settings (Admin -> Settings) arrive with every full state.
let CFG = { title: 'Couchside', subtitle: 'How well do you know the host?', host_name: 'the host', closes_text: '', photos: [], accent: '#FFCF33', vote_seconds: 45, final_seconds: 60, boosts: true };
function applyCfg(cfg, suffix) {
  if (!cfg) return;
  CFG = cfg;
  document.documentElement.style.setProperty('--accent', cfg.accent || '#FFCF33');
  document.title = cfg.title + (suffix ? ' \u00b7 ' + suffix : '');
  let badge = document.getElementById('demo-badge');
  if (cfg.demo && !badge) {
    badge = h('div', { id: 'demo-badge', class: 'demo-badge noprint' }, 'Demo \u00b7 everyone shares one game \u00b7 resets every hour');
    document.body.append(badge);
  } else if (!cfg.demo && badge) badge.remove();
}
const hostName = () => CFG.host_name || 'the host';
const HostName = () => { const n = hostName(); return n.charAt(0).toUpperCase() + n.slice(1); };

// Title with the last word in italics, e.g. "How well do you know *the host?*"
function fancyTitle(text) {
  const t = String(text || '').trim();
  const i = t.lastIndexOf(' ');
  return i > 0 ? [t.slice(0, i + 1), h('em', null, t.slice(i + 1))] : [h('em', null, t)];
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

async function call(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(j.error || ('Error ' + r.status)); e.status = r.status; throw e; }
  return j;
}

let toastTimer;
function toast(msg, isErr) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

function fmtPts(n) { return (n > 0 ? '+' : '') + n; }
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

// "How to play", built from the kinds of questions this game actually has.
function rules(prompts) {
  const kinds = new Set((prompts || []).map((p) => p.kind));
  const out = ['Answer the questions on your phone. ' + (CFG.closes_text ? CFG.closes_text + '. ' : '') + 'Then everyone votes together at the TV.'];
  if (kinds.has('mc')) out.push(`Multiple choice: +5 if you pick what ${hostName()} picked.`);
  if (kinds.has('text')) out.push(`Write-in (guess ${hostName()}): +5 if your answer matches ${hostName()}\u2019s, +1 for every vote your answer gets, +2 for voting for the right one, +1 for voting for the most popular one.`);
  if (kinds.has('funny')) out.push(`Funny rounds: no right answer. +${2} for every vote your answer gets, +1 for voting for the crowd favourite. You can\u2019t vote for yourself.`);
  if (kinds.has('text') && CFG.boosts) out.push('Boosts: one 2\u00d7 and one 3\u00d7 per game, for write-in rounds. Right = your +5 / +2 points multiplied. Wrong = lose 10 (2\u00d7) or 15 (3\u00d7). Points from votes you get are never touched.');
  out.push('Final question: bet up to half your points (everyone can bet at least 20). Right adds the bet, wrong takes it away.');
  return out;
}

// Lead-ins before the host's answer on the TV (one per question, so a refresh shows the same one).
const HOST_LINES = [
  () => `And ${hostName()} said\u2026`,
  () => 'The envelope, please\u2026',
  () => 'Survey says\u2026',
  () => `Straight from ${hostName()}\u2026`,
  () => 'The official answer\u2026',
  () => 'Drumroll, please\u2026',
  () => 'And the real answer is\u2026',
  () => `${HostName()} has spoken\u2026`,
];
const hostLine = (idx) => HOST_LINES[idx % HOST_LINES.length]() + ' \ud83e\udd41';

// Demo server: TV and admin log in by themselves (no PIN). Returns a token or null.
async function demoLogin() {
  try {
    const info = await call('/api/info');
    if (!info.demo) return null;
    const r = await call('/api/admin/login', { body: {} });
    store.set('ap_admin', r.token);
    return r.token;
  } catch { return null; }
}

// Grand finale timing, shared by the TV (animation) and phones (hold back the result until the winner is out).
function finaleTimes(n) {
  const roll1 = 1800, answer = roll1 + 3500, per = 2500;
  const places = answer + Math.max(0, n - 1) * per, roll2 = places + 3000;
  return { roll1, answer, per, places, roll2, total: roll2 + 500 };
}
