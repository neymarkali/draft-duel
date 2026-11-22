'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const SEED = require('./seed');

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL,
      email TEXT UNIQUE, pass_hash TEXT, google_sub TEXT UNIQUE, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS resets(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS results(
      duel_id TEXT, user_id TEXT, opp_name TEXT, opp_country TEXT, mine INTEGER, theirs INTEGER, outcome TEXT,
      md TEXT, ts INTEGER, bold_n INTEGER DEFAULT 0, best_pts INTEGER DEFAULT 0, best_player TEXT,
      PRIMARY KEY(duel_id, user_id));
    CREATE INDEX IF NOT EXISTS results_user ON results(user_id, ts);
    CREATE TABLE IF NOT EXISTS players(
      id TEXT PRIMARY KEY, first TEXT, last TEXT NOT NULL, pos TEXT NOT NULL, club TEXT, league TEXT,
      weight REAL DEFAULT 20, appear INTEGER DEFAULT 0, picked INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS duels(
      id TEXT PRIMARY KEY, p1 TEXT, p2 TEXT, bot_name TEXT, bot_country TEXT, md TEXT NOT NULL,
      status TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS duels_p1 ON duels(p1, created);
    CREATE INDEX IF NOT EXISTS duels_p2 ON duels(p2, created);
    CREATE TABLE IF NOT EXISTS queue(user_id TEXT PRIMARY KEY, since INTEGER NOT NULL, duel TEXT);
    CREATE TABLE IF NOT EXISTS stats(md TEXT, player_id TEXT, minutes INTEGER, goals INTEGER, assists INTEGER, cs INTEGER, saves INTEGER, yellow INTEGER, red INTEGER, owng INTEGER DEFAULT 0, PRIMARY KEY(md, player_id));
    CREATE TABLE IF NOT EXISTS matchdays(md TEXT PRIMARY KEY, finished INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS war(country TEXT PRIMARY KEY, pts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
  `);
  if (!db.prepare('PRAGMA table_info(stats)').all().some(c => c.name === 'owng')) db.exec('ALTER TABLE stats ADD COLUMN owng INTEGER DEFAULT 0');
  const n = db.prepare('SELECT COUNT(*) c FROM players').get().c;
  if (n === 0) {
    const ins = db.prepare('INSERT INTO players(id,first,last,pos,club,league,weight) VALUES(?,?,?,?,?,?,?)');
    for (const p of SEED) ins.run(...p);
  }
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

module.exports = { open, tx };
