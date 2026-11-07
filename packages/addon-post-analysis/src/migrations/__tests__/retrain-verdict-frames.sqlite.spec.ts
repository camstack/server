/**
 * The retrain backfill over a REAL verdict ledger on real SQLite: verdict-marked
 * staged tracks without a frame get one, a verdict given on a fused-away id is
 * also written under its survivor, the marked fields survive, and a rerun copies
 * and writes nothing (D987).
 */

import {
  type AddonMigrationHost,
  defineAddonMigrations,
  type MigrationMeta,
  type MigrationOwnerResult,
  runAddonMigrations,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import {
  ADDON_MIGRATIONS,
  RETRAIN_VERDICT_FRAMES_MIGRATION_ID,
  type PipelineAnalyticsMigrationPorts,
  type StagedRetrainTrack,
} from '../index.js'
import { makeNcWorld } from './support/nc-records-world.js'

const MARK = 'rule name the migration must keep'

/** The ledger the engine keeps for an owner: declared metas, then one outcome per id. */
function ledgerHost(): {
  host: AddonMigrationHost
  applied: Map<string, MigrationOwnerResult>
} {
  const metas: MigrationMeta[] = []
  const applied = new Map<string, MigrationOwnerResult>()
  const host: AddonMigrationHost = {
    declareOwner: async (input) => {
      metas.push(...input.metas)
      return {
        bootId: 'boot-1',
        snapshot: 'none' as const,
        steps: input.metas.map((m) => ({
          id: m.id,
          action: applied.has(m.id) ? ('skip' as const) : ('run' as const),
          state: applied.has(m.id) ? ('applied' as const) : ('pending' as const),
        })),
      }
    },
    startMigration: async () => ({
      proceed: true,
      state: 'pending' as const,
      reason: null,
    }),
    finishMigration: async ({ id, result }) => {
      if (result.kind === 'failed') {
        return {
          status: 'failed' as const,
          error: result.error,
          rowsChanged: 0,
        }
      }
      applied.set(id, result)
      return { status: 'applied' as const, error: null, rowsChanged: 0 }
    },
  }
  return { host, applied }
}

async function setup(input: {
  staged: StagedRetrainTrack[]
  aliases?: Record<string, string>
  gone?: readonly string[]
}) {
  const { records, ncPorts } = await makeNcWorld()
  const copies: string[] = []
  const staged = input.staged.map((t) => ({ ...t }))
  const ports: PipelineAnalyticsMigrationPorts = {
    ...ncPorts,
    resolveTrackAlias: async (id) => input.aliases?.[id] ?? null,
    listStagedTracks: async () => staged.map((t) => ({ ...t })),
    copyBestFrame: async ({ trackId }) => {
      if (input.gone?.includes(trackId) === true) return { ok: false as const, reason: 'no-candidate-frame' }
      copies.push(trackId)
      const row = staged.find((t) => t.trackId === trackId)
      if (row !== undefined) row.frameCount = 1
      return { ok: true as const }
    },
    listDeviceIds: async () => [],
    readDeviceField: async () => new Map(),
    readStored: async () => ({}),
    announceRetired: async () => undefined,
  }
  const verdict = (trackId: string) => ({
    trackId,
    deviceId: 101,
    verdict: 'correct' as const,
    userId: 'alice',
    ruleId: 'rule-1',
    ruleName: MARK,
    at: 1_000,
  })
  // One engine ledger for the whole test, so a second `run` sees the first as applied
  // only when the engine would; the procedure's own idempotence is what a rerun proves,
  // hence a fresh ledger per run.
  const run = async () =>
    runAddonMigrations(
      ledgerHost().host,
      defineAddonMigrations(
        ADDON_MIGRATIONS.filter((m) => m.meta.id === RETRAIN_VERDICT_FRAMES_MIGRATION_ID),
        ports,
      ),
      makeSilentLogger(),
    )
  return { records, ncPorts, ports, copies, verdict, run, staged }
}

describe('retrain verdict-frame backfill', () => {
  it('copies a frame for each verdict-marked staged track that holds none, and only those', async () => {
    const w = await setup({
      staged: [
        { deviceId: 101, trackId: 'answered-empty', frameCount: 0 },
        { deviceId: 101, trackId: 'answered-has-frame', frameCount: 2 },
        { deviceId: 101, trackId: 'never-answered', frameCount: 0 },
      ],
    })
    await w.ports.verdicts.record(w.verdict('answered-empty'))
    await w.ports.verdicts.record(w.verdict('answered-has-frame'))
    const report = await w.run()
    expect(report.failed).toEqual([])
    expect(w.copies).toEqual(['answered-empty'])
  })

  it('writes the verdict of a fused-away id under its survivor, keeping every field', async () => {
    const w = await setup({
      staged: [{ deviceId: 101, trackId: 'survivor', frameCount: 0 }],
      aliases: { absorbed: 'survivor' },
    })
    await w.ports.verdicts.record(w.verdict('absorbed'))
    await w.run()
    const rows = await w.ports.verdicts.all()
    const onSurvivor = rows.find((r) => r.trackId === 'survivor')
    expect(onSurvivor?.ruleName).toBe(MARK)
    expect(onSurvivor?.userId).toBe('alice')
    expect(w.copies).toEqual(['survivor'])
  })

  it('never overwrites a verdict the survivor already holds', async () => {
    const w = await setup({
      staged: [{ deviceId: 101, trackId: 'survivor', frameCount: 1 }],
      aliases: { absorbed: 'survivor' },
    })
    await w.ports.verdicts.record(w.verdict('absorbed'))
    await w.ports.verdicts.record({ ...w.verdict('survivor'), ruleName: 'the newer answer' })
    await w.run()
    const rows = await w.ports.verdicts.all()
    expect(rows.find((r) => r.trackId === 'survivor')?.ruleName).toBe('the newer answer')
  })

  it('a rerun copies nothing and writes no new row', async () => {
    const w = await setup({
      staged: [{ deviceId: 101, trackId: 'survivor', frameCount: 0 }],
      aliases: { absorbed: 'survivor' },
    })
    await w.ports.verdicts.record(w.verdict('absorbed'))
    await w.run()
    const rowsAfterFirst = (await w.ports.verdicts.all()).length
    const copiesAfterFirst = w.copies.length
    await w.run()
    expect(w.copies).toHaveLength(copiesAfterFirst)
    expect(await w.ports.verdicts.all()).toHaveLength(rowsAfterFirst)
  })

  it('a track whose media is gone is skipped and stays staged', async () => {
    const w = await setup({
      staged: [
        { deviceId: 101, trackId: 'lost', frameCount: 0 },
        { deviceId: 101, trackId: 'fine', frameCount: 0 },
      ],
      gone: ['lost'],
    })
    await w.ports.verdicts.record(w.verdict('lost'))
    await w.ports.verdicts.record(w.verdict('fine'))
    await w.run()
    expect(w.copies).toEqual(['fine'])
  })
})
