import type Database from 'better-sqlite3'

export interface DeviceRow {
  readonly stableId: string
  readonly type: string
  readonly name: string
  readonly parentStableId: string | null
  readonly enabled: boolean
}

interface InsertInput {
  readonly stableId: string
  readonly type: string
  readonly name: string
  readonly parentStableId: string | null
}

export class DeviceStore {
  constructor(private readonly db: Database.Database) {}

  insert(addonId: string, device: InsertInput): void {
    this.db
      .prepare(
        `INSERT INTO devices (addon_id, stable_id, type, name, parent_stable_id) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(addonId, device.stableId, device.type, device.name, device.parentStableId)
  }

  listByAddon(addonId: string): readonly DeviceRow[] {
    return this.db
      .prepare(
        `SELECT stable_id as stableId, type, name, parent_stable_id as parentStableId, enabled FROM devices WHERE addon_id = ?`,
      )
      .all(addonId) as DeviceRow[]
  }

  listChildren(addonId: string, parentStableId: string): readonly DeviceRow[] {
    return this.db
      .prepare(
        `SELECT stable_id as stableId, type, name, parent_stable_id as parentStableId, enabled FROM devices WHERE addon_id = ? AND parent_stable_id = ?`,
      )
      .all(addonId, parentStableId) as DeviceRow[]
  }

  remove(addonId: string, stableId: string): void {
    this.db
      .prepare(`DELETE FROM devices WHERE addon_id = ? AND stable_id = ?`)
      .run(addonId, stableId)
  }
}
