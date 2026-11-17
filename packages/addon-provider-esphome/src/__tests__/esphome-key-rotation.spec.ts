import type { BoardKeyListResult, BoardKeyResult, BoardKeySource } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { EspBrokerEntry } from '../config.js'
import type { KeyImportBoards, KeySourceClient } from '../esphome-key-import.js'
import { EspKeyRotation } from '../esphome-key-rotation.js'
import { captureLogger, type LogLine } from './fake-ctx.js'

function board(id: string, name: string, host: string): EspBrokerEntry {
  return {
    id,
    name,
    integrationId: 'int_1',
    connection: { host, port: 6053, noisePsk: 'OLD', password: '' },
  }
}

class FakeBoards implements KeyImportBoards {
  readonly sets: { boardId: string; key: string }[] = []
  constructor(private readonly entries: EspBrokerEntry[]) {}
  boards(): readonly EspBrokerEntry[] {
    return this.entries
  }
  async setBoardKey(_integrationId: string, boardId: string, key: string) {
    this.sets.push({ boardId, key })
    return 'set' as const
  }
}

const SOURCE: BoardKeySource = { sourceId: 'ha_001', name: 'Home' }
const LISTING: BoardKeyListResult = {
  ok: true,
  boards: [
    { configuration: 'kitchen.yaml', name: 'kitchen', address: null },
    { configuration: 'attic.yaml', name: 'attic', address: null },
  ],
}

function client(key: BoardKeyResult): { client: KeySourceClient; reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    client: {
      listSources: async () => [SOURCE],
      listBoards: async () => LISTING,
      getBoardKey: async ({ configuration }) => {
        reads.push(configuration)
        return key
      },
    },
  }
}

function setup(key: BoardKeyResult = { ok: true, key: 'NEW' }) {
  const boards = new FakeBoards([
    board('b1', 'kitchen', '10.0.0.5'),
    board('b2', 'attic', '10.0.0.6'),
  ])
  const source = client(key)
  const lines: LogLine[] = []
  const rotation = new EspKeyRotation({
    boards,
    keySources: () => source.client,
    logger: captureLogger(lines),
    deviceIdFor: (boardId) => (boardId === 'b1' ? 41 : undefined),
  })
  return { rotation, boards, reads: source.reads, lines }
}

describe('EspKeyRotation', () => {
  it('a rejected key fetches that board key once and stores it', async () => {
    const { rotation, boards, reads } = setup()
    await rotation.onPermanentFailure('b1', 'encryption-key-invalid')
    expect(reads).toEqual(['kitchen.yaml'])
    expect(boards.sets).toEqual([{ boardId: 'b1', key: 'NEW' }])
  })

  it('any other permanent reason fetches nothing', async () => {
    const { rotation, reads } = setup()
    await rotation.onPermanentFailure('b1', 'encryption-key-missing')
    await rotation.onPermanentFailure('b1', 'auth')
    expect(reads).toEqual([])
  })

  it('is bounded: a second rejection before the board connects fetches nothing', async () => {
    const { rotation, reads } = setup()
    await rotation.onPermanentFailure('b1', 'encryption-key-invalid')
    await rotation.onPermanentFailure('b1', 'encryption-key-invalid')
    expect(reads).toEqual(['kitchen.yaml'])
  })

  it('a rejection arriving while the fetch is in flight does not start another', async () => {
    const { rotation, reads } = setup()
    const first = rotation.onPermanentFailure('b1', 'encryption-key-invalid')
    const second = rotation.onPermanentFailure('b1', 'encryption-key-invalid')
    await Promise.all([first, second])
    expect(reads).toEqual(['kitchen.yaml'])
  })

  it('a board that connected again may fetch once more on the next rejection', async () => {
    const { rotation, reads } = setup()
    await rotation.onPermanentFailure('b1', 'encryption-key-invalid')
    rotation.onConnected('b1')
    await rotation.onPermanentFailure('b1', 'encryption-key-invalid')
    expect(reads).toEqual(['kitchen.yaml', 'kitchen.yaml'])
  })

  it('the bound is per board', async () => {
    const { rotation, reads } = setup()
    await rotation.onPermanentFailure('b1', 'encryption-key-invalid')
    await rotation.onPermanentFailure('b2', 'encryption-key-invalid')
    expect(reads).toEqual(['kitchen.yaml', 'attic.yaml'])
  })

  it('a failed read writes nothing and the existing key stays (D49)', async () => {
    const { rotation, boards } = setup({ ok: false, reason: 'unreachable' })
    await rotation.onPermanentFailure('b1', 'encryption-key-invalid')
    expect(boards.sets).toEqual([])
  })

  it('a key source that throws is logged, not raised', async () => {
    const boards = new FakeBoards([board('b1', 'kitchen', '10.0.0.5')])
    const lines: LogLine[] = []
    const rotation = new EspKeyRotation({
      boards,
      keySources: () => ({
        listSources: async () => [SOURCE],
        listBoards: async () => {
          throw new Error('boom')
        },
        getBoardKey: async () => ({ ok: false, reason: 'unreachable' }),
      }),
      logger: captureLogger(lines),
      deviceIdFor: () => 41,
    })
    await expect(rotation.onPermanentFailure('b1', 'encryption-key-invalid')).resolves.toBeNull()
    expect(boards.sets).toEqual([])
    expect(lines.some((l) => l.level === 'warn')).toBe(true)
  })

  it('logs the outcome tagged with the board device id and never the key', async () => {
    const { rotation, lines } = setup()
    await rotation.onPermanentFailure('b1', 'encryption-key-invalid')
    const own = lines.filter((l) => l.message.startsWith('key rotation'))
    expect(own.length).toBeGreaterThan(0)
    for (const l of own) expect(l.extras).toMatchObject({ tags: { deviceId: 41 } })
    expect(JSON.stringify(lines)).not.toContain('NEW')
  })
})
