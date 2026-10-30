import { describe, expect, it } from 'vitest'
import { makeSecretMarker, REDACTED_SECRET } from '@camstack/types'
import type { EspBrokerEntry, EspConnection } from '../config.js'
import {
  BOARD_SECRET_PATHS,
  EspIntegrationBoards,
  parseBoards,
  type EspBoardsApi,
  type EspBoardSessions,
  type EspIntegrationRef,
} from '../esphome-integration-boards.js'
import { captureLogger, type LogLine } from './fake-ctx.js'

const ADDON = 'provider-esphome'

interface SessionCall {
  readonly op: 'create' | 'update' | 'remove'
  readonly id: string
}

class FakeSessions implements EspBoardSessions {
  readonly calls: SessionCall[] = []
  readonly connections = new Map<string, EspConnection>()
  list(): readonly { id: string }[] {
    return [...this.connections.keys()].map((id) => ({ id }))
  }
  async createEntry(
    _name: string,
    connection: EspConnection,
    options: { id: string },
  ): Promise<void> {
    this.calls.push({ op: 'create', id: options.id })
    this.connections.set(options.id, connection)
  }
  async updateEntry(id: string, connection: EspConnection): Promise<void> {
    this.calls.push({ op: 'update', id })
    this.connections.set(id, connection)
  }
  async removeEntry(id: string): Promise<void> {
    this.calls.push({ op: 'remove', id })
    this.connections.delete(id)
  }
  hasSameConnection(id: string, c: Readonly<EspConnection>): boolean {
    const cur = this.connections.get(id)
    return (
      cur !== undefined &&
      cur.host === c.host &&
      cur.port === c.port &&
      cur.noisePsk === c.noisePsk &&
      cur.password === c.password
    )
  }
}

interface SetCall {
  readonly id: string
  readonly settings: Record<string, unknown>
  readonly secretKeys: string[]
  readonly skipRestart: true
}

class FakeApi implements EspBoardsApi {
  readonly integrations: EspIntegrationRef[] = []
  readonly settings = new Map<string, Record<string, unknown>>()
  readonly sets: SetCall[] = []
  unreadable = new Set<string>()
  /** A door that loses the row secrets, like a locked keychain would. */
  dropSecrets = false
  async listIntegrations(): Promise<readonly EspIntegrationRef[]> {
    return [...this.integrations]
  }
  async getSettings(id: string): Promise<Record<string, unknown>> {
    if (this.unreadable.has(id)) throw new Error('settings read failed')
    return structuredClone(this.settings.get(id) ?? {})
  }
  async setSettings(input: SetCall): Promise<void> {
    this.sets.push(input)
    const stored = this.settings.get(input.id) ?? {}
    const incoming = structuredClone(input.settings)
    const boards = incoming['boards']
    if (this.dropSecrets && Array.isArray(boards)) {
      incoming['boards'] = boards.map((b: Record<string, unknown>) => ({ ...b, encryptionKey: '' }))
    }
    this.settings.set(input.id, { ...stored, ...incoming })
  }
}

class FakeLegacy {
  records: EspBrokerEntry[] = []
  removed: string[][] = []
  async listResolved(): Promise<EspBrokerEntry[]> {
    return [...this.records]
  }
  async remove(ids: readonly string[]): Promise<void> {
    this.removed.push([...ids])
    this.records = this.records.filter((r) => !ids.includes(r.id))
  }
}

function world() {
  const api = new FakeApi()
  const sessions = new FakeSessions()
  const legacy = new FakeLegacy()
  const cascaded: string[] = []
  const lines: LogLine[] = []
  const boards = new EspIntegrationBoards({
    addonId: ADDON,
    api,
    sessions,
    legacy,
    cascadeRemoveDevices: async (id) => {
      cascaded.push(id)
    },
    logger: captureLogger(lines),
  })
  return { api, sessions, legacy, cascaded, lines, boards }
}

function row(id: string, host: string, key = '') {
  return { id, host, port: 6053, name: '', encryptionKey: key, password: '' }
}

function integration(id: string, enabled = true): EspIntegrationRef {
  return { id, addonId: ADDON, enabled }
}

describe('migration of a single-board integration', () => {
  const legacyRecord: EspBrokerEntry = {
    id: 'esp_legacy1',
    name: 'Kitchen relay',
    connection: {
      host: 'kitchen.local',
      port: 6054,
      noisePsk: 'KEY-MARK-123',
      password: 'PW-MARK-456',
    },
    integrationId: 'int_1',
  }

  it('keeps the board id, the key and the password, and drops the old record only after', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', { brokerId: 'esp_legacy1', unrelated: 'KEEP-ME' })
    w.legacy.records = [legacyRecord]

    const report = await w.boards.migrateLegacy()
    await w.boards.reconcile()

    expect(report.migrated).toEqual(['esp_legacy1'])
    expect(w.api.sets).toHaveLength(1)
    const saved = w.api.sets[0]
    expect(saved?.skipRestart).toBe(true)
    expect(saved?.secretKeys).toEqual(expect.arrayContaining([...BOARD_SECRET_PATHS]))
    expect(BOARD_SECRET_PATHS).toEqual(
      expect.arrayContaining(['boards[id].encryptionKey', 'boards[id].password']),
    )
    expect(w.api.settings.get('int_1')).toMatchObject({
      unrelated: 'KEEP-ME',
      boards: [
        {
          id: 'esp_legacy1',
          host: 'kitchen.local',
          port: 6054,
          name: 'Kitchen relay',
          encryptionKey: 'KEY-MARK-123',
          password: 'PW-MARK-456',
        },
      ],
    })
    expect(w.legacy.removed).toEqual([['esp_legacy1']])
    // The session that runs is the migrated board, with the same id (devices key on it) and key.
    expect(w.sessions.connections.get('esp_legacy1')).toEqual({
      host: 'kitchen.local',
      port: 6054,
      noisePsk: 'KEY-MARK-123',
      password: 'PW-MARK-456',
    })
  })

  it('is idempotent: a second run writes nothing', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', { brokerId: 'esp_legacy1' })
    w.legacy.records = [legacyRecord]
    await w.boards.migrateLegacy()
    await w.boards.migrateLegacy()
    expect(w.api.sets).toHaveLength(1)
  })

  it('crash after the settings write: the next boot finds the row and removes the record', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', {
      brokerId: 'esp_legacy1',
      boards: [row('esp_legacy1', 'kitchen.local', 'KEY-MARK-123')],
    })
    w.api.settings.get('int_1')!['boards'] = [
      {
        ...row('esp_legacy1', 'kitchen.local', 'KEY-MARK-123'),
        port: 6054,
        password: 'PW-MARK-456',
        name: 'Kitchen relay',
      },
    ]
    w.legacy.records = [legacyRecord]
    const report = await w.boards.migrateLegacy()
    expect(w.api.sets).toHaveLength(0)
    expect(report.migrated).toEqual(['esp_legacy1'])
    expect(w.legacy.removed).toEqual([['esp_legacy1']])
  })

  it('keeps the old record when the saved row lost the key', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', { brokerId: 'esp_legacy1' })
    w.api.dropSecrets = true
    w.legacy.records = [legacyRecord]
    const report = await w.boards.migrateLegacy()
    expect(report.migrated).toEqual([])
    expect(w.legacy.removed).toEqual([])
    expect(w.legacy.records).toHaveLength(1)
  })

  it('copies nothing when the old record could not be unlocked', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', { brokerId: 'esp_legacy1' })
    w.legacy.records = [
      { ...legacyRecord, connection: { ...legacyRecord.connection, noisePsk: REDACTED_SECRET } },
    ]
    await w.boards.migrateLegacy()
    expect(w.api.sets).toHaveLength(0)
    expect(w.legacy.removed).toEqual([])
  })

  it('leaves a board no integration points at, and says so', async () => {
    const w = world()
    w.legacy.records = [{ ...legacyRecord, integrationId: undefined }]
    const report = await w.boards.migrateLegacy()
    expect(report.unlinked).toEqual(['esp_legacy1'])
    expect(w.legacy.records).toHaveLength(1)
    expect(w.lines.some((l) => l.level === 'warn')).toBe(true)
  })
})

describe('reconcile: several boards in one integration', () => {
  it('runs one session per board', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', {
      boards: [row('b1', 'a.local', 'K1'), row('b2', 'b.local', 'K2')],
    })
    await w.boards.reconcile()
    expect([...w.sessions.connections.keys()].sort()).toEqual(['b1', 'b2'])
    expect(
      w.boards
        .boardsOf('int_1')
        .map((b) => b.id)
        .sort(),
    ).toEqual(['b1', 'b2'])
  })

  it('adding a row starts only that board; removing one stops only that board and its devices', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', { boards: [row('b1', 'a.local', 'K1')] })
    await w.boards.reconcile()
    w.sessions.calls.length = 0

    w.api.settings.set('int_1', {
      boards: [row('b1', 'a.local', 'K1'), row('b2', 'b.local', 'K2')],
    })
    await w.boards.reconcile()
    expect(w.sessions.calls).toEqual([{ op: 'create', id: 'b2' }])

    w.sessions.calls.length = 0
    w.api.settings.set('int_1', { boards: [row('b2', 'b.local', 'K2')] })
    await w.boards.reconcile()
    expect(w.sessions.calls).toEqual([{ op: 'remove', id: 'b1' }])
    expect(w.cascaded).toEqual(['b1'])
  })

  it('a changed key restarts only that board', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', {
      boards: [row('b1', 'a.local', 'K1'), row('b2', 'b.local', 'K2')],
    })
    await w.boards.reconcile()
    w.sessions.calls.length = 0
    w.api.settings.set('int_1', {
      boards: [row('b1', 'a.local', 'K1'), row('b2', 'b.local', 'K2-NEW')],
    })
    await w.boards.reconcile()
    expect(w.sessions.calls).toEqual([{ op: 'update', id: 'b2' }])
  })

  it('a disabled integration disconnects its boards but keeps their devices', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', { boards: [row('b1', 'a.local')] })
    await w.boards.reconcile()
    w.api.integrations[0] = integration('int_1', false)
    await w.boards.reconcile()
    expect(w.sessions.connections.size).toBe(0)
    expect(w.cascaded).toEqual([])
  })

  it('a deleted integration takes its boards and devices with it', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', { boards: [row('b1', 'a.local')] })
    await w.boards.reconcile()
    w.api.integrations.length = 0
    await w.boards.reconcile()
    expect(w.sessions.connections.size).toBe(0)
    expect(w.cascaded).toEqual(['b1'])
  })

  it('an unreadable integration changes nothing', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', { boards: [row('b1', 'a.local')] })
    await w.boards.reconcile()
    w.sessions.calls.length = 0
    w.api.unreadable.add('int_1')
    await w.boards.reconcile()
    expect(w.sessions.calls).toEqual([])
    expect(w.cascaded).toEqual([])
  })

  it('does not start a board whose key the keychain cannot serve', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    const marker = makeSecretMarker(
      'secret://provider-esphome/integration/int_1/boards[b1].encryptionKey',
    )
    w.api.settings.set('int_1', {
      boards: [{ ...row('b1', 'a.local'), encryptionKey: marker }, row('b2', 'b.local', 'K2')],
    })
    await w.boards.reconcile()
    expect([...w.sessions.connections.keys()]).toEqual(['b2'])
    expect(parseBoards('int_1', w.api.settings.get('int_1') ?? {}).problems).toEqual([
      { id: 'b1', reason: 'secret unavailable' },
    ])
  })
})

describe('adding and removing a board through the integration', () => {
  it('adds a board, connecting only it, and keeps the rows already there', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', { boards: [row('b1', 'a.local', 'K1')] })
    await w.boards.reconcile()
    w.sessions.calls.length = 0

    const added = await w.boards.addBoard('int_1', {
      host: 'new.local',
      name: 'New one',
      encryptionKey: 'NEW-KEY',
    })

    expect(w.sessions.calls).toEqual([{ op: 'create', id: added.id }])
    expect(w.api.sets[0]?.skipRestart).toBe(true)
    expect(w.api.sets[0]?.secretKeys).toEqual(expect.arrayContaining([...BOARD_SECRET_PATHS]))
    const saved = w.api.settings.get('int_1')?.['boards']
    expect(saved).toHaveLength(2)
    expect(w.sessions.connections.get(added.id)?.noisePsk).toBe('NEW-KEY')
    expect(w.sessions.connections.get('b1')?.noisePsk).toBe('K1')
  })

  it('adding the same host and port twice adds nothing', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', { boards: [row('b1', 'a.local', 'K1')] })
    await w.boards.reconcile()
    const again = await w.boards.addBoard('int_1', { host: 'a.local' })
    expect(again.id).toBe('b1')
    expect(w.api.sets).toHaveLength(0)
  })

  it('refuses an integration that is not an ESPHome one', async () => {
    const w = world()
    w.api.integrations.push({ id: 'int_x', addonId: 'provider-other', enabled: true })
    await expect(w.boards.addBoard('int_x', { host: 'a.local' })).rejects.toThrow(/not an ESPHome/)
  })

  it('removing a board stops only it and removes its devices', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.api.settings.set('int_1', {
      boards: [row('b1', 'a.local', 'K1'), row('b2', 'b.local', 'K2')],
    })
    await w.boards.reconcile()
    w.sessions.calls.length = 0
    await w.boards.removeBoard('int_1', 'b1')
    expect(w.sessions.calls).toEqual([{ op: 'remove', id: 'b1' }])
    expect(w.cascaded).toEqual(['b1'])
    expect(w.sessions.connections.has('b2')).toBe(true)
  })
})
