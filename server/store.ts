// Scene storage on node:sqlite. One table, JSON documents — scenes are always
// loaded and saved whole, so there's nothing for an ORM to model.

import { DatabaseSync } from 'node:sqlite';

export interface SceneRow { id: string; name: string; document: string; updatedAt: number }

export function openStore(path: string) {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      document TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const listStatement = database.prepare('SELECT id, name, updated_at AS updatedAt FROM scenes ORDER BY updated_at DESC');
  const getStatement = database.prepare('SELECT id, name, document, updated_at AS updatedAt FROM scenes WHERE id = ?');
  const upsertStatement = database.prepare(`
    INSERT INTO scenes (id, name, document, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, document = excluded.document, updated_at = excluded.updated_at
  `);
  const deleteStatement = database.prepare('DELETE FROM scenes WHERE id = ?');

  return {
    list: () => listStatement.all() as unknown as { id: string; name: string; updatedAt: number }[],
    get: (id: string) => getStatement.get(id) as unknown as SceneRow | undefined,
    put: (id: string, name: string, document: string): number => {
      const now = Date.now();
      upsertStatement.run(id, name, document, now, now);
      return now;
    },
    remove: (id: string) => { deleteStatement.run(id); },
    close: () => database.close(),
  };
}
