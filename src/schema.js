// Database schema. Runs on the first request after each deploy (CREATE IF NOT EXISTS),
// so a fresh D1 database needs no manual setup step.
import starter from '../public/packs/general.json';

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS game (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    phase TEXT NOT NULL DEFAULT 'answer',
    ver INTEGER NOT NULL DEFAULT 1,
    act INTEGER NOT NULL DEFAULT 0,
    reveal_idx INTEGER NOT NULL DEFAULT 0,
    reveal_step INTEGER NOT NULL DEFAULT 0,
    final_deadline INTEGER,
    step_deadline INTEGER,
    joins_open INTEGER NOT NULL DEFAULT 1,
    join_code TEXT NOT NULL
  )`,
  // kind: mc (pick one) | text (guess the host's answer) | funny (funniest answer wins) | number (final only)
  `CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    options TEXT,
    host_answer TEXT,
    is_final INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    created INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS answers (
    player_id INTEGER NOT NULL,
    prompt_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    cluster_id INTEGER,
    PRIMARY KEY (player_id, prompt_id)
  )`,
  `CREATE TABLE IF NOT EXISTS clusters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    is_match INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS votes (
    player_id INTEGER NOT NULL,
    prompt_id INTEGER NOT NULL,
    cluster_id INTEGER NOT NULL,
    PRIMARY KEY (player_id, prompt_id)
  )`,
  `CREATE TABLE IF NOT EXISTS chips (
    player_id INTEGER NOT NULL,
    mult INTEGER NOT NULL,
    prompt_id INTEGER NOT NULL,
    PRIMARY KEY (player_id, mult)
  )`,
  `CREATE TABLE IF NOT EXISTS wagers (
    player_id INTEGER PRIMARY KEY,
    answer TEXT NOT NULL,
    amount INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    exp INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rl (
    k TEXT PRIMARY KEY,
    n INTEGER NOT NULL,
    exp INTEGER NOT NULL
  )`,
  // k = 'config' (JSON, public settings) | 'ai_key' (never sent to browsers)
  `CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  )`,
];

// Starter questions, added once to a brand-new database (the "general" pack).
// The 'seeded' flag means deleting questions later never brings them back.
export function seedStatements(db) {
  const notSeeded = "NOT EXISTS (SELECT 1 FROM settings WHERE k = 'seeded')";
  const qs = starter.questions || [];
  return [
    ...qs.map((q, i) => db.prepare(
      `INSERT INTO prompts (ord, text, kind, options, host_answer, is_final) SELECT ?, ?, ?, ?, ?, ? WHERE ${notSeeded}`
    ).bind(i + 1, q.text, q.kind || 'text', q.options ? JSON.stringify(q.options) : null, q.host_answer || null, q.is_final ? 1 : 0)),
    db.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('seeded', '1')"),
  ];
}
