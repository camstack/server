import type Database from 'better-sqlite3'

export class ConfigStore {
  constructor(private readonly db: Database.Database) {}

  save(addonId: string, stableId: string | null, data: Record<string, unknown>): void {
    // Two partial unique indexes enforce uniqueness (one for null, one for non-null stable_id).
    // SQLite resolves ON CONFLICT to the matching partial index automatically.
    if (stableId === null) {
      this.db
        .prepare(
          `INSERT INTO addon_config (addon_id, stable_id, data, updated_at)
           VALUES (?, NULL, ?, datetime('now'))
           ON CONFLICT(addon_id) WHERE stable_id IS NULL
           DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        )
        .run(addonId, JSON.stringify(data))
    } else {
      this.db
        .prepare(
          `INSERT INTO addon_config (addon_id, stable_id, data, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(addon_id, stable_id) WHERE stable_id IS NOT NULL
           DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        )
        .run(addonId, stableId, JSON.stringify(data))
    }
  }

  load(addonId: string, stableId: string | null): Record<string, unknown> {
    const row =
      stableId === null
        ? (this.db
            .prepare(`SELECT data FROM addon_config WHERE addon_id = ? AND stable_id IS NULL`)
            .get(addonId) as { data: string } | undefined)
        : (this.db
            .prepare(`SELECT data FROM addon_config WHERE addon_id = ? AND stable_id = ?`)
            .get(addonId, stableId) as { data: string } | undefined)

    return row ? (JSON.parse(row.data) as Record<string, unknown>) : {}
  }

  remove(addonId: string, stableId: string | null): void {
    if (stableId === null) {
      this.db
        .prepare(`DELETE FROM addon_config WHERE addon_id = ? AND stable_id IS NULL`)
        .run(addonId)
    } else {
      this.db
        .prepare(`DELETE FROM addon_config WHERE addon_id = ? AND stable_id = ?`)
        .run(addonId, stableId)
    }
  }
}
