/**
 * The unmarked node fields of the runner, the broker and the analyzer become node settings, on
 * real SQLite in the canonical `addon-settings` layout: every node row is copied from the bare row,
 * a twin conflict throws and writes nothing, a loser is parked as superseded (never deleted), a
 * marked field survives and a second run is a no-op.
 */
import { describe, expect, it } from 'vitest'
import { ADDON_MIGRATIONS as ANALYZER } from '../audio-analyzer/addons/analyzer/migrations/index.js'
import { ADDON_MIGRATIONS as RUNNER, NODE_FIELDS_ID } from '../pipeline-runner/migrations/index.js'
import { ADDON_MIGRATIONS as BROKER } from '../stream-broker/migrations/index.js'
import { perNodeFixture } from './node-fields-fixture.js'

const NEIGHBOUR = 'keep-me'
const NODES = ['hub', 'agent-1']
const row = (addonId: string, key: string, value: unknown, nodeId?: string) =>
  nodeId === undefined ? { addonId, key, value } : { addonId, key, value, nodeId }
const runner = (bare: Record<string, unknown>) =>
  perNodeFixture('pipeline-runner', RUNNER, bare, NEIGHBOUR, NODES)

describe('pipeline-runner unmarked-node-fields-per-node', () => {
  it('copies each tuning field to every node row, carrying nodeId, and keeps the bare rows', async () => {
    const f = runner({ maxQueueDepth: 40, minThrottledFps: 3, unknownMarked: { mark: 'survive' } })
    expect(await f.boot()).toEqual({ failed: [], applied: [NODE_FIELDS_ID] })
    const rows = f.rows()
    for (const node of NODES) {
      expect(rows[`pipeline-runner.maxQueueDepth@${node}`]).toEqual(
        row('pipeline-runner', `maxQueueDepth@${node}`, 40, node),
      )
      expect(rows[`pipeline-runner.minThrottledFps@${node}`]?.['value']).toBe(3)
    }
    expect(rows['pipeline-runner.maxQueueDepth']).toEqual(
      row('pipeline-runner', 'maxQueueDepth', 40),
    )
    // A marked field the migration does not know survives byte for byte, and gets no node row.
    expect(rows['pipeline-runner.unknownMarked']).toEqual(
      row('pipeline-runner', 'unknownMarked', { mark: 'survive' }),
    )
    expect(rows['pipeline-runner.unknownMarked@hub']).toBeUndefined()
    expect(rows['other-addon.maxQueueDepth']?.['value']).toBe(NEIGHBOUR)
  })

  it('folds a twin into an unset survivor and parks the loser, never deleting it', async () => {
    const f = runner({ nodeDecodeBudgetMb: 6144, 'decodeMaxLiveWorkers@agent-1': 4 })
    await f.boot()
    const rows = f.rows()
    expect(rows['pipeline-runner.decodeBudgetMb@hub']?.['value']).toBe(6144)
    expect(rows['pipeline-runner.decodeBudgetMb@agent-1']?.['value']).toBe(6144)
    expect(rows['pipeline-runner.maxLiveDecodeWorkers@agent-1']).toEqual(
      row('pipeline-runner', 'maxLiveDecodeWorkers@agent-1', 4, 'agent-1'),
    )
    expect(rows['pipeline-runner.maxLiveDecodeWorkers@hub']).toBeUndefined()
    // Losers are renamed, the value kept.
    expect(rows['pipeline-runner.nodeDecodeBudgetMb']).toBeUndefined()
    expect(rows['pipeline-runner.nodeDecodeBudgetMb~superseded']?.['value']).toBe(6144)
    expect(rows['pipeline-runner.decodeMaxLiveWorkers@agent-1']).toBeUndefined()
    expect(rows['pipeline-runner.decodeMaxLiveWorkers~superseded@agent-1']).toEqual(
      row('pipeline-runner', 'decodeMaxLiveWorkers~superseded@agent-1', 4, 'agent-1'),
    )
  })

  it('a node override against the cluster value is not a conflict: it wins on its node, the cluster value reaches the rest, and the plain keys copy', async () => {
    // The prod shape: the cluster values are bare, one node carries its own limit.
    const f = runner({
      maxQueueDepth: 40,
      maxLiveDecodeWorkers: 8,
      nodeDecodeBudgetMb: 8192,
      'decodeMaxLiveWorkers@agent-1': 4,
    })
    expect(await f.boot()).toEqual({ failed: [], applied: [NODE_FIELDS_ID] })
    expect(f.warnings).toEqual([])
    const rows = f.rows()
    expect(rows['pipeline-runner.maxLiveDecodeWorkers@agent-1']?.['value']).toBe(4)
    expect(rows['pipeline-runner.maxLiveDecodeWorkers@hub']?.['value']).toBe(8)
    expect(rows['pipeline-runner.decodeBudgetMb@hub']?.['value']).toBe(8192)
    expect(rows['pipeline-runner.decodeBudgetMb@agent-1']?.['value']).toBe(8192)
    expect(rows['pipeline-runner.maxQueueDepth@hub']?.['value']).toBe(40)
    expect(rows['pipeline-runner.maxQueueDepth@agent-1']?.['value']).toBe(40)
    expect(rows['pipeline-runner.decodeMaxLiveWorkers~superseded@agent-1']?.['value']).toBe(4)
  })

  it('two values of the SAME level that disagree leave that twin alone, say so, and still copy the plain keys', async () => {
    const f = runner({
      maxQueueDepth: 40,
      maxLiveDecodeWorkers: 8,
      decodeMaxLiveWorkers: 4,
      nodeDecodeBudgetMb: 6144,
    })
    expect(await f.boot()).toEqual({ failed: [], applied: [NODE_FIELDS_ID] })
    const rows = f.rows()
    expect(f.warnings.length).toBeGreaterThan(0)
    expect(f.warnings[0]).toContain('maxLiveDecodeWorkers')
    // The conflicting twin is untouched, losers included.
    expect(rows['pipeline-runner.maxLiveDecodeWorkers@hub']).toBeUndefined()
    expect(rows['pipeline-runner.decodeMaxLiveWorkers']?.['value']).toBe(4)
    expect(rows['pipeline-runner.decodeMaxLiveWorkers~superseded']).toBeUndefined()
    // The plain keys and the other twin are not blocked.
    expect(rows['pipeline-runner.maxQueueDepth@agent-1']?.['value']).toBe(40)
    expect(rows['pipeline-runner.decodeBudgetMb@hub']?.['value']).toBe(6144)
  })

  it('a survivor equal to its twin is not a conflict; the loser is parked', async () => {
    const f = runner({ maxLiveDecodeWorkers: 4, 'decodeMaxLiveWorkers@agent-1': 4 })
    expect((await f.boot()).failed).toEqual([])
    expect(f.rows()['pipeline-runner.decodeMaxLiveWorkers~superseded@agent-1']).toBeDefined()
  })

  it('a second run is a no-op', async () => {
    const f = runner({ maxQueueDepth: 40, nodeDecodeBudgetMb: 6144, 'decodeMaxLiveWorkers@hub': 2 })
    await f.boot()
    const after = f.rows()
    expect(await f.boot()).toEqual({ failed: [], applied: [NODE_FIELDS_ID] })
    expect(f.rows()).toEqual(after)
  })

  it('never overwrites a value already on a node row', async () => {
    const f = runner({ maxQueueDepth: 40, 'maxQueueDepth@agent-1': 70 })
    await f.boot()
    expect(f.rows()['pipeline-runner.maxQueueDepth@agent-1']?.['value']).toBe(70)
    expect(f.rows()['pipeline-runner.maxQueueDepth@hub']?.['value']).toBe(40)
  })
})

describe('stream-broker and audio-analyzer unmarked-node-fields-per-node', () => {
  it('copies rtspPort to every node row', async () => {
    const f = perNodeFixture('stream-broker', BROKER, { rtspPort: 9554 }, NEIGHBOUR, NODES)
    await f.boot()
    for (const node of NODES) {
      expect(f.rows()[`stream-broker.rtspPort@${node}`]).toEqual(
        row('stream-broker', `rtspPort@${node}`, 9554, node),
      )
    }
  })

  it('copies audioBackend to every node row, so a set choice reaches every node', async () => {
    const f = perNodeFixture('audio-analyzer', ANALYZER, { audioBackend: 'yamnet' }, NEIGHBOUR, [
      'hub',
      'agent-1',
      'agent-2',
    ])
    await f.boot()
    for (const node of ['hub', 'agent-1', 'agent-2']) {
      expect(f.rows()[`audio-analyzer.audioBackend@${node}`]?.['value']).toBe('yamnet')
    }
  })
})
