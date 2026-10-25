/**
 * The operator-driven orphan reclaim — the three properties that make it safe
 * to hand an operator a button pointed at 74,700 rows (D161).
 *
 *  1. Omitting `mode` is a DRY RUN. The settings form sends `{}` for a
 *     field-less button, and an unstated intent must not delete anything.
 *  2. The pass YIELDS between pages. `better-sqlite3` is synchronous on
 *     hub-main's only thread; a reclaim that never gives it back is a stall,
 *     and this process has already produced a 30-second one.
 *  3. It REPORTS bytes, not just rows — the whole reason the leak went unseen
 *     was a byte counter that could only ever be 0.
 */
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { MEDIA_COLLECTION } from '../../store/media-store.js'
import { OrphanAuditActionInputSchema } from '../orphan-audit-actions.js'
import {
  auditScope,
  buildOrphanScopes,
  DEFAULT_ORPHAN_LIMITS,
  type OrphanAuditDeps,
  type OrphanRow,
  type OrphanScope,
} from '../orphan-audit.js'

const NOW = 10_000_000_000
const OLD = NOW - 90 * 24 * 60 * 60 * 1000
/** The media scope, unsharded — see the note in `orphan-audit.spec.ts`. */
const MEDIA_SCOPE: OrphanScope = {
  ...buildOrphanScopes().find((s) => s.collection === MEDIA_COLLECTION)!,
  id: MEDIA_COLLECTION,
  shard: null,
}

function orphanRows(count: number, bytesEach: number): readonly OrphanRow[] {
  return Array.from({ length: count }, (_unused, i) => ({
    key: `m-${i}`,
    data: {
      ownerKind: 'track',
      ownerId: `dead-${i}`,
      deviceId: 104,
      timestamp: OLD,
      sizeBytes: bytesEach,
    },
  }))
}

function deps(input: { rows: readonly OrphanRow[]; breaths?: number[] }): {
  deps: OrphanAuditDeps
  reclaimed: string[]
} {
  const reclaimed: string[] = []
  const remaining = (): readonly OrphanRow[] => input.rows.filter((r) => !reclaimed.includes(r.key))
  return {
    reclaimed,
    deps: {
      page: async (_c, _shard, offset, limit) => remaining().slice(offset, offset + limit),
      size: async () => remaining().length,
      liveTrackIds: async () => new Set<string>(),
      liveEventIds: async () => new Set<string>(),
      // The BYTES come from the delete itself (D480) — `deleteConfirmed`
      // answers with what it actually removed.
      reclaim: async (_c, key, _row) => {
        reclaimed.push(key)
        const row = input.rows.find((r) => r.key === key)
        return { rows: 1, bytes: row === undefined ? null : Number(row.data['sizeBytes'] ?? 0) }
      },
      now: () => NOW,
      logger: makeSilentLogger(),
      ...(input.breaths
        ? {
            breathe: async () => {
              input.breaths?.push(1)
            },
          }
        : {}),
    },
  }
}

describe('retention.orphanAudit — the operator action contract', () => {
  it('an input with no mode is a DRY RUN', () => {
    expect(OrphanAuditActionInputSchema.parse({}).mode).toBe('report')
    // And the word has to be typed for anything to be deleted.
    expect(OrphanAuditActionInputSchema.parse({ mode: 'reclaim' }).mode).toBe('reclaim')
  })

  it('report mode counts the orphans and their BYTES while deleting nothing', async () => {
    const h = deps({ rows: orphanRows(12, 250_000) })

    const report = await auditScope(
      MEDIA_SCOPE,
      h.deps,
      { ...DEFAULT_ORPHAN_LIMITS, mode: 'report', pageSize: 5 },
      0,
    )

    expect(report.orphans).toBe(12)
    expect(h.reclaimed).toEqual([])
    // Nothing was freed, and it says 0 because nothing was freed — which is a
    // different statement from the structural zero this change removed.
    expect(report.bytesReclaimed).toBe(0)
  })

  it('reclaim mode frees the rows and reports the real byte total', async () => {
    const h = deps({ rows: orphanRows(12, 250_000) })

    const report = await auditScope(
      MEDIA_SCOPE,
      h.deps,
      { ...DEFAULT_ORPHAN_LIMITS, mode: 'reclaim', pageSize: 5 },
      0,
    )

    expect(report.reclaimed).toBe(12)
    expect(h.reclaimed).toHaveLength(12)
    expect(report.bytesReclaimed).toBe(12 * 250_000)
  })

  it('gives the thread back between pages instead of holding it for the pass', async () => {
    const breaths: number[] = []
    const h = deps({ rows: orphanRows(12, 1_000), breaths })

    await auditScope(
      MEDIA_SCOPE,
      h.deps,
      { ...DEFAULT_ORPHAN_LIMITS, mode: 'reclaim', pageSize: 4 },
      0,
    )

    // 12 rows at 4/page — the pass must not be one uninterrupted block.
    expect(breaths.length).toBeGreaterThanOrEqual(3)
  })

  it('still refuses to exceed the per-scope reclaim ceiling', async () => {
    const h = deps({ rows: orphanRows(50, 1_000) })

    const report = await auditScope(
      MEDIA_SCOPE,
      h.deps,
      {
        ...DEFAULT_ORPHAN_LIMITS,
        mode: 'reclaim',
        pageSize: 10,
        maxReclaimPerScope: 7,
      },
      0,
    )

    expect(report.reclaimed).toBe(7)
    expect(report.stoppedBy).toBe('reclaim-ceiling')
    // Visible, not silent — and it resumes where it stopped.
    expect(report.nextCursor).toBeGreaterThan(0)
  })
})
