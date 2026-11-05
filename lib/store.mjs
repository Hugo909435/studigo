import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function createStore(directory) {
  const root = resolve(directory);
  mkdirSync(join(root, 'media'), { recursive: true });
  const db = new DatabaseSync(join(root, 'studio.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const save = db.prepare('INSERT INTO posts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body');
  return {
    root, media: join(root, 'media'),
    save(p) { p.updatedAt = new Date().toISOString(); save.run(p.id, JSON.stringify(p)); return p; },
    get(id) { const row = db.prepare('SELECT body FROM posts WHERE id=?').get(id); return row && JSON.parse(row.body); },
    list() { return db.prepare('SELECT body FROM posts').all().map(r => JSON.parse(r.body)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); },
    setting(k, value) { if (value !== undefined) db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(value)); const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r && JSON.parse(r.value); },
    remove(id) { db.prepare('DELETE FROM posts WHERE id=?').run(id); },
    bytes() { return readdirSync(join(root,'media')).reduce((n,f) => n + statSync(join(root,'media',f)).size, 0); },
    close() { db.close(); }
  };
}
