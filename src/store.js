import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const FIELDS = Object.freeze([
  'productionOrder',
  'product',
  'productionTotal',
  'currentProduction',
  'now',
]);

export const MAX_FIELD_LENGTH = 256;

// Keep the original text instead of converting through Number: even very large
// values, leading zeroes and decimal places must be copied without rounding.
export function isNumberText(value) {
  return typeof value === 'string' &&
    value.length <= MAX_FIELD_LENGTH &&
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);
}

export function createStore(databasePath) {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS interface_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      values_json TEXT NOT NULL,
      versions_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS confirmation_receipts (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expected_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS confirmation_receipts_created_at
      ON confirmation_receipts(created_at);
  `);

  const initialValues = Object.fromEntries(FIELDS.map((field) => [field, '']));
  const initialVersions = Object.fromEntries(FIELDS.map((field) => [field, 0]));
  db.prepare(`
    INSERT OR IGNORE INTO interface_state (id, revision, values_json, versions_json)
    VALUES (1, 0, ?, ?)
  `).run(JSON.stringify(initialValues), JSON.stringify(initialVersions));

  const readRow = db.prepare(
    'SELECT revision, values_json, versions_json FROM interface_state WHERE id = 1',
  );
  const writeRow = db.prepare(`
    UPDATE interface_state
    SET revision = ?, values_json = ?, versions_json = ?
    WHERE id = 1
  `);
  const readReceipt = db.prepare(
    'SELECT value, expected_version FROM confirmation_receipts WHERE id = ?',
  );
  const writeReceipt = db.prepare(`
    INSERT INTO confirmation_receipts (id, value, expected_version, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const removeOldReceipts = db.prepare(
    'DELETE FROM confirmation_receipts WHERE created_at < ?',
  );

  function getState() {
    const row = readRow.get();
    return {
      revision: row.revision,
      values: JSON.parse(row.values_json),
      versions: JSON.parse(row.versions_json),
    };
  }

  function saveState(state) {
    writeRow.run(state.revision, JSON.stringify(state.values), JSON.stringify(state.versions));
  }

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function updateField(field, value, expectedVersion) {
    return transaction(() => {
      const state = getState();
      if (state.versions[field] !== expectedVersion) {
        // A retry whose response was lost is safe when it already has exactly
        // the intended value. It must not overwrite any different remote edit.
        if (state.values[field] === value) return { state, changed: false };
        return { state, changed: false, conflict: true };
      }
      if (state.values[field] === value) return { state, changed: false };

      state.values[field] = value;
      state.versions[field] += 1;
      state.revision += 1;
      saveState(state);
      return { state, changed: true };
    });
  }

  function confirm(id, value, expectedVersion) {
    return transaction(() => {
      const receipt = readReceipt.get(id);
      const state = getState();
      if (receipt) {
        if (receipt.value !== value || receipt.expected_version !== expectedVersion) {
          return { state, changed: false, invalidReceipt: true };
        }
        // Retrying the same confirmation never clears a later user's new input.
        return { state, changed: false, duplicate: true };
      }
      if (state.versions.now !== expectedVersion) {
        return { state, changed: false, conflict: true };
      }

      state.values.currentProduction = value;
      state.values.now = '0';
      state.versions.currentProduction += 1;
      state.versions.now += 1;
      state.revision += 1;
      saveState(state);
      const timestamp = Date.now();
      writeReceipt.run(id, value, expectedVersion, timestamp);
      // Keep retry receipts for 30 days, rather than growing the database forever.
      removeOldReceipts.run(timestamp - 30 * 24 * 60 * 60 * 1000);
      return { state, changed: true };
    });
  }

  return { getState, updateField, confirm, close: () => db.close() };
}
