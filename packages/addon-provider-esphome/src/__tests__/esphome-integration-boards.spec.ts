import { describe, expect, it } from 'vitest'
import { REDACTED_SECRET } from '@camstack/types'
import type { EspConnection } from '../config.js'
import type { EspBoardsStore } from '../esphome-instances.js'
import {
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

class FakeApi implements EspBoardsApi {
  readonly integrations: EspIntegrationRef[] = []
  async listIntegrations(): Promise<readonly EspIntegrationRef[]> {
    return [...this.integrations]
  }
}

class FakeStore implements EspBoardsStore {
  readonly rows = new Map<string, Record<string, unknown>[]>()
  readonly writes: { readonly id: string; readonly rows: Record<string, unknown>[] }[] = []
  unreadable = new Set<string>()
  async read(id: string): Promise<readonly Record<string, unknown>[]> {
    if (this.unreadable.has(id)) throw new Error('record read failed')
    return structuredClone(this.rows.get(id) ?? [])
  }
  async write(id: string, rows: readonly Record<string, unknown>[]): Promise<void> {
    this.writes.push({ id, rows: structuredClone([...rows]) })
    this.rows.set(id, structuredClone([...rows]))
  }
}

function world() {
  const api = new FakeApi()
  const store = new FakeStore()
  const sessions = new FakeSessions()
  const cascaded: string[] = []
  const lines: LogLine[] = []
  const boards = new EspIntegrationBoards({
    addonId: ADDON,
    api,
    store,
    sessions,
    cascadeRemoveDevices: async (id) => {
      cascaded.push(id)
    },
    logger: captureLogger(lines),
  })
  return { api, store, sessions, cascaded, lines, boards }
}

function row(id: string, host: string, key = '') {
  return { id, host, port: 6053, name: '', encryptionKey: key, password: '' }
}

function integration(id: string, enabled = true): EspIntegrationRef {
  return { id, addonId: ADDON, enabled }
}

describe('reconcile: several boards in one integration', () => {
  it('runs one session per board', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.store.rows.set('int_1', [row('b1', 'a.local', 'K1'), row('b2', 'b.local', 'K2')])
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
    w.store.rows.set('int_1', [row('b1', 'a.local', 'K1')])
    await w.boards.reconcile()
    w.sessions.calls.length = 0

    w.store.rows.set('int_1', [row('b1', 'a.local', 'K1'), row('b2', 'b.local', 'K2')])
    await w.boards.reconcile()
    expect(w.sessions.calls).toEqual([{ op: 'create', id: 'b2' }])

    w.sessions.calls.length = 0
    w.store.rows.set('int_1', [row('b2', 'b.local', 'K2')])
    await w.boards.reconcile()
    expect(w.sessions.calls).toEqual([{ op: 'remove', id: 'b1' }])
    expect(w.cascaded).toEqual(['b1'])
  })

  it('a changed key restarts only that board', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.store.rows.set('int_1', [row('b1', 'a.local', 'K1'), row('b2', 'b.local', 'K2')])
    await w.boards.reconcile()
    w.sessions.calls.length = 0
    w.store.rows.set('int_1', [row('b1', 'a.local', 'K1'), row('b2', 'b.local', 'K2-NEW')])
    await w.boards.reconcile()
    expect(w.sessions.calls).toEqual([{ op: 'update', id: 'b2' }])
  })

  it('a disabled integration disconnects its boards but keeps their devices', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.store.rows.set('int_1', [row('b1', 'a.local')])
    await w.boards.reconcile()
    w.api.integrations[0] = integration('int_1', false)
    await w.boards.reconcile()
    expect(w.sessions.connections.size).toBe(0)
    expect(w.cascaded).toEqual([])
  })

  it('a deleted integration takes its boards and devices with it', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.store.rows.set('int_1', [row('b1', 'a.local')])
    await w.boards.reconcile()
    w.api.integrations.length = 0
    await w.boards.reconcile()
    expect(w.sessions.connections.size).toBe(0)
    expect(w.cascaded).toEqual(['b1'])
  })

  it('an unreadable integration changes nothing', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.store.rows.set('int_1', [row('b1', 'a.local')])
    await w.boards.reconcile()
    w.sessions.calls.length = 0
    w.store.unreadable.add('int_1')
    await w.boards.reconcile()
    expect(w.sessions.calls).toEqual([])
    expect(w.cascaded).toEqual([])
  })

  it('does not start a board whose key the keychain cannot serve', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.store.rows.set('int_1', [
      { ...row('b1', 'a.local'), encryptionKey: REDACTED_SECRET },
      row('b2', 'b.local', 'K2'),
    ])
    await w.boards.reconcile()
    expect([...w.sessions.connections.keys()]).toEqual(['b2'])
    expect(parseBoards('int_1', w.store.rows.get('int_1') ?? []).problems).toEqual([
      { id: 'b1', reason: 'secret unavailable' },
    ])
  })
})

describe('adding and removing a board through the integration', () => {
  it('adds a board, connecting only it, and keeps the rows already there', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.store.rows.set('int_1', [row('b1', 'a.local', 'K1')])
    await w.boards.reconcile()
    w.sessions.calls.length = 0

    const added = await w.boards.addBoard('int_1', {
      host: 'new.local',
      name: 'New one',
      encryptionKey: 'NEW-KEY',
    })

    expect(w.sessions.calls).toEqual([{ op: 'create', id: added.id }])
    expect(w.store.writes).toHaveLength(1)
    expect(w.store.rows.get('int_1')).toHaveLength(2)
    expect(w.sessions.connections.get(added.id)?.noisePsk).toBe('NEW-KEY')
    expect(w.sessions.connections.get('b1')?.noisePsk).toBe('K1')
  })

  it('adding the same host and port twice adds nothing', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.store.rows.set('int_1', [row('b1', 'a.local', 'K1')])
    await w.boards.reconcile()
    const again = await w.boards.addBoard('int_1', { host: 'a.local' })
    expect(again.id).toBe('b1')
    expect(w.store.writes).toHaveLength(0)
  })

  it('refuses an integration that is not an ESPHome one', async () => {
    const w = world()
    w.api.integrations.push({ id: 'int_x', addonId: 'provider-other', enabled: true })
    await expect(w.boards.addBoard('int_x', { host: 'a.local' })).rejects.toThrow(/not an ESPHome/)
  })

  it('removing a board stops only it and removes its devices', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.store.rows.set('int_1', [row('b1', 'a.local', 'K1'), row('b2', 'b.local', 'K2')])
    await w.boards.reconcile()
    w.sessions.calls.length = 0
    await w.boards.removeBoard('int_1', 'b1')
    expect(w.sessions.calls).toEqual([{ op: 'remove', id: 'b1' }])
    expect(w.cascaded).toEqual(['b1'])
    expect(w.sessions.connections.has('b2')).toBe(true)
  })
})

describe('setting the key of an existing board', () => {
  it('saves the key, restarts only that board session and keeps the other rows', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.store.rows.set('int_1', [row('b1', 'a.local', 'OLD'), row('b2', 'b.local', 'K2')])
    await w.boards.reconcile()
    w.sessions.calls.length = 0

    expect(await w.boards.setBoardKey('int_1', 'b1', 'NEW-KEY')).toBe('set')

    expect(w.sessions.calls).toEqual([{ op: 'update', id: 'b1' }])
    expect(w.store.writes).toHaveLength(1)
    expect(w.sessions.connections.get('b1')?.noisePsk).toBe('NEW-KEY')
    expect(w.sessions.connections.get('b2')?.noisePsk).toBe('K2')
  })

  it('writes nothing when the key is already the stored one, or the board is gone', async () => {
    const w = world()
    w.api.integrations.push(integration('int_1'))
    w.store.rows.set('int_1', [row('b1', 'a.local', 'SAME')])
    await w.boards.reconcile()
    expect(await w.boards.setBoardKey('int_1', 'b1', 'SAME')).toBe('unchanged')
    expect(await w.boards.setBoardKey('int_1', 'nope', 'X')).toBe('missing')
    expect(w.store.writes).toHaveLength(0)
  })
})
