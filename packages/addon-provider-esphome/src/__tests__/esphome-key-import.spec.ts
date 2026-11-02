import type { BoardKeyListResult, BoardKeyResult, BoardKeySource } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { EspBrokerEntry } from '../config.js'
import {
  importBoardKeys,
  type KeyImportBoards,
  type KeySourceClient,
} from '../esphome-key-import.js'
import { captureLogger, type LogLine } from './fake-ctx.js'

function board(id: string, name: string, host: string, key = ''): EspBrokerEntry {
  return {
    id,
    name,
    integrationId: 'int_1',
    connection: { host, port: 6053, noisePsk: key, password: '' },
  }
}

class FakeBoards implements KeyImportBoards {
  readonly sets: { integrationId: string; boardId: string; key: string }[] = []
  constructor(private readonly entries: EspBrokerEntry[]) {}
  boards(): readonly EspBrokerEntry[] {
    return this.entries
  }
  async setBoardKey(integrationId: string, boardId: string, key: string) {
    this.sets.push({ integrationId, boardId, key })
    return 'set' as const
  }
}

interface SourceScript {
  sources: BoardKeySource[]
  list: Record<string, BoardKeyListResult>
  keys: Record<string, BoardKeyResult>
}

function client(script: SourceScript): KeySourceClient {
  return {
    listSources: async () => script.sources,
    listBoards: async ({ sourceId }) =>
      script.list[sourceId] ?? { ok: false, reason: 'unknown-source' },
    getBoardKey: async ({ sourceId, configuration }) =>
      script.keys[`${sourceId}/${configuration}`] ?? { ok: false, reason: 'unknown-board' },
  }
}

const SOURCE: BoardKeySource = { sourceId: 'ha_001', name: 'Home' }
const LISTING: BoardKeyListResult = {
  ok: true,
  boards: [
    { configuration: 'kitchen.yaml', name: 'kitchen', address: 'kitchen.local' },
    { configuration: 'attic.yaml', name: 'attic', address: null },
  ],
}

function run(entries: EspBrokerEntry[], script: SourceScript) {
  const boards = new FakeBoards(entries)
  const lines: LogLine[] = []
  const done = importBoardKeys({
    boards,
    keySources: client(script),
    logger: captureLogger(lines),
  })
  return { boards, lines, done }
}

describe('importBoardKeys', () => {
  it('matches by name or by host, and stores the key it read', async () => {
    const { boards, done } = run(
      [board('b1', 'kitchen', '10.0.0.5'), board('b2', '', 'attic.local')],
      {
        sources: [SOURCE],
        list: { ha_001: LISTING },
        keys: {
          'ha_001/kitchen.yaml': { ok: true, key: 'K-KITCHEN' },
          'ha_001/attic.yaml': { ok: true, key: 'K-ATTIC' },
        },
      },
    )
    const results = await done
    expect(results.map((r) => [r.boardId, r.outcome])).toEqual([
      ['b1', 'imported'],
      ['b2', 'imported'],
    ])
    expect(boards.sets.map((s) => [s.boardId, s.key])).toEqual([
      ['b1', 'K-KITCHEN'],
      ['b2', 'K-ATTIC'],
    ])
  })

  it('reports a board whose key cannot be read with the reason, and never writes for it', async () => {
    const { boards, done } = run([board('b1', 'kitchen', 'kitchen.local', 'EXISTING')], {
      sources: [SOURCE],
      list: { ha_001: LISTING },
      keys: { 'ha_001/kitchen.yaml': { ok: false, reason: 'not-admin' } },
    })
    const [only] = await done
    expect(only).toMatchObject({ boardId: 'b1', outcome: 'not-imported', reason: 'not-admin' })
    expect(boards.sets).toEqual([])
  })

  it('reports an unmatched board, an ambiguous match and a failed source listing', async () => {
    const ambiguous: BoardKeyListResult = {
      ok: true,
      boards: [
        { configuration: 'a1.yaml', name: 'twin', address: null },
        { configuration: 'a2.yaml', name: 'twin', address: null },
      ],
    }
    const stranger = run([board('b1', 'stranger', 'other.local')], {
      sources: [SOURCE],
      list: { ha_001: LISTING },
      keys: {},
    })
    expect((await stranger.done)[0]).toMatchObject({ outcome: 'not-imported', reason: 'no-match' })

    const twin = run([board('b1', 'twin', 'x.local')], {
      sources: [SOURCE],
      list: { ha_001: ambiguous },
      keys: {},
    })
    expect((await twin.done)[0]).toMatchObject({ outcome: 'not-imported', reason: 'ambiguous' })

    const down = run([board('b1', 'kitchen', 'k.local')], {
      sources: [SOURCE],
      list: { ha_001: { ok: false, reason: 'unreachable' } },
      keys: {},
    })
    expect((await down.done)[0]).toMatchObject({ outcome: 'not-imported', reason: 'unreachable' })
    expect(down.boards.sets).toEqual([])
  })

  it('reports no-source when nothing can supply keys', async () => {
    const { done, boards } = run([board('b1', 'kitchen', 'k.local')], {
      sources: [],
      list: {},
      keys: {},
    })
    expect((await done)[0]).toMatchObject({ outcome: 'not-imported', reason: 'no-source' })
    expect(boards.sets).toEqual([])
  })

  it('never logs the key', async () => {
    const { lines, done } = run([board('b1', 'kitchen', 'k.local')], {
      sources: [SOURCE],
      list: { ha_001: LISTING },
      keys: { 'ha_001/kitchen.yaml': { ok: true, key: 'SECRET-KEY-VALUE' } },
    })
    await done
    expect(JSON.stringify(lines)).not.toContain('SECRET-KEY-VALUE')
  })
})
