/**
 * The legacy data the Terminal catalogue meets on a node that last ran a release which kept its
 * instances in the addon settings (`terminalInstances`): written by hand, in the shape that release
 * stored it, with a MARK in a field a migration that re-built a row would drop
 * (`profileSettings.mark`). The replay and the real-SQLite spec both seed from here.
 */
import type Database from 'better-sqlite3'

export const TERMINAL_SEED_ADDON = 'terminal'

export interface TerminalSeedRow {
  readonly id: string
  readonly cameraStableId: string
  readonly nodeId: string
  readonly profileId: string
  readonly profileLabel: string
  readonly name: string
  readonly enabled: boolean
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly environment: readonly string[]
  readonly profileSettings: Readonly<Record<string, unknown>>
}

/** An automatic instance, and an adopted legacy monitor that keeps its historic stable id. */
export const TERMINAL_SEED_ROWS: readonly TerminalSeedRow[] = [
  {
    id: '3f2a9c1e-4b7d-4e55-9a10-0d6f5c7b8a01',
    cameraStableId: 'terminal-camera-instance-3f2a9c1e-4b7d-4e55-9a10-0d6f5c7b8a01',
    nodeId: 'hub',
    profileId: 'glances',
    profileLabel: 'Glances',
    name: 'Hub glances',
    enabled: true,
    executable: '',
    args: ['--time', '2'],
    cwd: '/tmp',
    environment: ['TERM=xterm-256color'],
    profileSettings: { showCpu: true, showSensors: false, mark: 'glances-mark' },
  },
  {
    id: '7c1d5e20-91aa-4f0b-8c33-2b9e6d4a7f02',
    cameraStableId: 'terminal-camera-agent-1',
    nodeId: 'agent-1',
    profileId: 'monitor',
    profileLabel: 'BTM',
    name: 'Agent monitor',
    enabled: false,
    executable: '',
    args: [],
    cwd: '',
    environment: [],
    profileSettings: { mark: 'monitor-mark' },
  },
]

/** Write the legacy list the way the settings writer stored it: one `<addonId>.<key>` row. */
export function seedTerminalLegacySettings(db: Database.Database): void {
  db.prepare('INSERT OR REPLACE INTO "addon-settings" (id, data) VALUES (?, ?)').run(
    `${TERMINAL_SEED_ADDON}.terminalInstances`,
    JSON.stringify({
      addonId: TERMINAL_SEED_ADDON,
      key: 'terminalInstances',
      value: TERMINAL_SEED_ROWS,
    }),
  )
}
