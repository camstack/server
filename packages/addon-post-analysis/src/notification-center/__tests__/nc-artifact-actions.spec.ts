/**
 * The `nc.listArtifacts` / `nc.getArtifact` bridge actions — the viewer's read
 * surface over the notification centre's artefact library (task #36).
 *
 * Three things are on the line and every one of them has already gone wrong
 * elsewhere in this bridge:
 *
 *  - the caller is SERVER-derived and the check is FAIL-CLOSED (an absent
 *    forwarded caller is never admin, and never anonymous-but-allowed);
 *  - visibility is per row, and an admin flag that could ride in on the INPUT
 *    blob would hand any caller every user's personal artefacts;
 *  - a node with no index REFUSES rather than answering an empty list, which an
 *    operator reads as "my timelapses are gone".
 */

import { NcRuleAiStore } from '../rule-ai-store.js'
import { ncRecordKinds } from '../record-kinds.js'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcArtifactIndex, type NcArtifactIndexInput } from '../artifact-index.js'
import { makeNcActionHandlers, type NcActionHandlers } from '../nc-actions.js'
import { NcRuleStore } from '../rule-store.js'
import { makeNcRecords } from './support/nc-test-deps.js'

const RETENTION_MS = 14 * 24 * 3600_000
const ADMIN = { userId: 'admin-1', isAdmin: true }
const ALICE = { userId: 'alice', isAdmin: false }
const BOB = { userId: 'bob', isAdmin: false }

let clock = 1_700_000_000_000
let seq = 0
const nextId = (): string =>
  `${clock}-3f2504e0-4f89-11d3-9a0c-0305e82c33${String((seq += 1) % 100).padStart(2, '0')}`

interface FakeShelf {
  readonly removed: string[]
  fail: boolean
  remove: (id: string) => Promise<boolean>
}

interface Ctx {
  readonly handlers: NcActionHandlers
  readonly index: NcArtifactIndex
  readonly shelf: FakeShelf
}

async function makeCtx(withIndex = true): Promise<Ctx> {
  const world = makeNcRecords()
  const index = new NcArtifactIndex({
    records: world.records,
    logger: makeSilentLogger(),
    addonId: 'pipeline-analytics',
    retentionMs: RETENTION_MS,
    now: () => clock,
  })
  const removed: string[] = []
  const shelf: FakeShelf = {
    removed,
    fail: false,
    remove: async (id: string) => {
      if (shelf.fail) return false
      removed.push(id)
      return true
    },
  }
  const handlers = makeNcActionHandlers({
    ruleStore: new NcRuleStore({
      kind: world.records.kind(ncRecordKinds.rules),
      logger: makeSilentLogger(),
    }),
    ruleAiStore: NcRuleAiStore.of(world.records, makeSilentLogger()),
    logger: makeSilentLogger(),
    listCallerTargetIds: async () => [],
    snooze: {
      list: () => [],
      create: () => Promise.reject(new Error('unused')),
      cancel: () => Promise.resolve(),
    },
    ...(withIndex ? { artifacts: index } : {}),
    artifactShelf: { remove: (id: string) => shelf.remove(id) },
  })
  return { handlers, index, shelf }
}

function artifact(over: Partial<NcArtifactIndexInput> = {}): NcArtifactIndexInput {
  return {
    id: nextId(),
    kind: 'timelapse',
    mime: 'video/mp4',
    sizeBytes: 2048,
    capturedAt: clock,
    deviceId: 102,
    deviceIds: [102],
    ...over,
  }
}

beforeEach(() => {
  clock = 1_700_000_000_000
  seq = 0
})

describe('nc.listArtifacts', () => {
  it('answers a page of metadata and never bytes', async () => {
    const ctx = await makeCtx()
    await ctx.index.record(artifact({ ruleName: 'Vialetto notte' }))
    const out = await ctx.handlers['nc.listArtifacts']({ limit: 50, offset: 0 }, ADMIN)
    expect(out.total).toBe(1)
    expect(out.hasMore).toBe(false)
    const row = out.artifacts[0]
    expect(row?.ruleName).toBe('Vialetto notte')
    expect(row?.mediaType).toBe('video')
    // The bytes ride a data plane, not tRPC: base64 over the bridge is how a
    // page of twenty timelapses becomes a hundred megabytes of envelope.
    expect(row?.downloadPath).toBe(`/addon/pipeline-analytics/nc-artifact-read/${row?.id ?? ''}`)
    expect(row).not.toHaveProperty('base64')
    expect(row).not.toHaveProperty('bytes')
  })

  it('forwards the filters to the index', async () => {
    const ctx = await makeCtx()
    await ctx.index.record(artifact({ kind: 'timelapse', capturedAt: 100 }))
    await ctx.index.record(
      artifact({ kind: 'summary-mosaic', mime: 'image/jpeg', capturedAt: 200 }),
    )
    const out = await ctx.handlers['nc.listArtifacts'](
      { limit: 50, offset: 0, kinds: ['summary-mosaic'] },
      ADMIN,
    )
    expect(out.artifacts.map((a) => a.kind)).toEqual(['summary-mosaic'])
  })

  // The whole reason the action is `caller: 'required'`.
  it('scopes visibility to the SERVER-derived caller', async () => {
    const ctx = await makeCtx()
    await ctx.index.record(artifact({ capturedAt: 100 }))
    await ctx.index.record(artifact({ capturedAt: 200, ownerUserId: 'alice' }))
    expect((await ctx.handlers['nc.listArtifacts']({ limit: 50, offset: 0 }, ALICE)).total).toBe(2)
    expect((await ctx.handlers['nc.listArtifacts']({ limit: 50, offset: 0 }, BOB)).total).toBe(1)
    expect((await ctx.handlers['nc.listArtifacts']({ limit: 50, offset: 0 }, ADMIN)).total).toBe(2)
  })

  it('refuses an absent caller rather than answering as anyone', async () => {
    const ctx = await makeCtx()
    await ctx.index.record(artifact())
    await expect(
      ctx.handlers['nc.listArtifacts']({ limit: 50, offset: 0 }, undefined),
    ).rejects.toThrow(/forbidden/i)
  })

  it('refuses honestly on a node that hosts no index', async () => {
    const ctx = await makeCtx(false)
    await expect(ctx.handlers['nc.listArtifacts']({ limit: 50, offset: 0 }, ADMIN)).rejects.toThrow(
      /does not host/i,
    )
  })
})

describe('nc.getArtifact', () => {
  it('answers one artefact', async () => {
    const ctx = await makeCtx()
    const rec = await ctx.index.record(artifact())
    const out = await ctx.handlers['nc.getArtifact']({ artifactId: rec?.id ?? '' }, ADMIN)
    expect(out.artifact?.id).toBe(rec?.id)
  })

  // Unknown / expired / not-yours all answer the same way: a surface that
  // distinguishes them reports what other people own.
  it('answers null for unknown AND for another user’s artefact alike', async () => {
    const ctx = await makeCtx()
    const mine = await ctx.index.record(artifact({ ownerUserId: 'alice' }))
    expect((await ctx.handlers['nc.getArtifact']({ artifactId: 'nope' }, BOB)).artifact).toBeNull()
    expect(
      (await ctx.handlers['nc.getArtifact']({ artifactId: mine?.id ?? '' }, BOB)).artifact,
    ).toBeNull()
    expect(
      (await ctx.handlers['nc.getArtifact']({ artifactId: mine?.id ?? '' }, ALICE)).artifact,
    ).not.toBeNull()
  })

  it('refuses an absent caller', async () => {
    const ctx = await makeCtx()
    await expect(ctx.handlers['nc.getArtifact']({ artifactId: 'x' }, undefined)).rejects.toThrow(
      /forbidden/i,
    )
  })

  it('refuses honestly on a node that hosts no index', async () => {
    const ctx = await makeCtx(false)
    await expect(ctx.handlers['nc.getArtifact']({ artifactId: 'x' }, ADMIN)).rejects.toThrow(
      /does not host/i,
    )
  })
})

/**
 * Deleting an artefact. The gap the viewer's library had: everything else in
 * that gallery could be removed and a hub-produced artefact could not, so the
 * only way to get rid of a timelapse was to wait out its retention.
 */
describe('nc.deleteArtifact', () => {
  it('removes the row AND the bytes, and says what it took', async () => {
    const ctx = await makeCtx()
    const row = await ctx.index.record(artifact())
    const id = row?.id ?? ''

    const out = await ctx.handlers['nc.deleteArtifact']({ artifactId: id }, ADMIN)

    expect(out.deleted).toBe(true)
    expect(out.removedIds).toEqual([id])
    expect(ctx.shelf.removed).toEqual([id])
    expect(await ctx.index.get(id, ADMIN)).toBeNull()
  })

  it("takes a video's POSTER with it — a still nothing lists is a leak", async () => {
    const ctx = await makeCtx()
    const poster = await ctx.index.record(
      artifact({ kind: 'timelapse-preview', mime: 'image/jpeg', sizeBytes: 64 }),
    )
    const video = await ctx.index.record(artifact({ posterArtifactId: poster?.id }))

    const out = await ctx.handlers['nc.deleteArtifact']({ artifactId: video?.id ?? '' }, ADMIN)

    expect([...out.removedIds].sort()).toEqual([poster?.id ?? '', video?.id ?? ''].sort())
    expect(await ctx.index.get(poster?.id ?? '', ADMIN)).toBeNull()
  })

  it("refuses another user's artefact the same way it refuses a missing one", async () => {
    // Two answers that differ would report what other people own — the rule
    // `nc.getArtifact` already follows.
    const ctx = await makeCtx()
    const mine = await ctx.index.record(artifact({ ownerUserId: 'alice' }))

    const out = await ctx.handlers['nc.deleteArtifact']({ artifactId: mine?.id ?? '' }, BOB)
    const absent = await ctx.handlers['nc.deleteArtifact']({ artifactId: 'nope' }, BOB)

    expect(out).toEqual(absent)
    expect(out.deleted).toBe(false)
    expect(ctx.shelf.removed).toEqual([])
    expect(await ctx.index.get(mine?.id ?? '', ALICE)).not.toBeNull()
  })

  it('lets an owner delete their own, and an admin delete a global one', async () => {
    const ctx = await makeCtx()
    const hers = await ctx.index.record(artifact({ ownerUserId: 'alice' }))
    const global = await ctx.index.record(artifact())

    expect(
      (await ctx.handlers['nc.deleteArtifact']({ artifactId: hers?.id ?? '' }, ALICE)).deleted,
    ).toBe(true)
    expect(
      (await ctx.handlers['nc.deleteArtifact']({ artifactId: global?.id ?? '' }, ADMIN)).deleted,
    ).toBe(true)
  })

  it('refuses a GLOBAL artefact for a non-admin — it is not theirs to remove', async () => {
    const ctx = await makeCtx()
    const global = await ctx.index.record(artifact())
    const out = await ctx.handlers['nc.deleteArtifact']({ artifactId: global?.id ?? '' }, ALICE)
    expect(out.deleted).toBe(false)
    expect(await ctx.index.get(global?.id ?? '', ALICE)).not.toBeNull()
  })

  it('drops the row even when the shelf could not unlink the file', async () => {
    // The row is the only thing that LISTS an artefact. Keeping it because the
    // unlink failed leaves a card that opens nothing; dropping it leaves a file
    // the age sweep still collects. The sweep is the backstop, the row is not.
    const ctx = await makeCtx()
    ctx.shelf.fail = true
    const row = await ctx.index.record(artifact())

    const out = await ctx.handlers['nc.deleteArtifact']({ artifactId: row?.id ?? '' }, ADMIN)

    expect(out.deleted).toBe(true)
    expect(await ctx.index.get(row?.id ?? '', ADMIN)).toBeNull()
  })

  it('refuses an absent caller rather than deleting as anyone', async () => {
    const ctx = await makeCtx()
    const row = await ctx.index.record(artifact())
    await expect(
      ctx.handlers['nc.deleteArtifact']({ artifactId: row?.id ?? '' }, undefined),
    ).rejects.toThrow(/forbidden/i)
  })
})

describe('the artefact index is built before the shelf locality is judged', () => {
  const src = readFileSync(new URL('../../pipeline-analytics/index.ts', import.meta.url), 'utf8')

  it('the index is created ABOVE the shelf refusal, so every node can answer a read', () => {
    // Shipped the other way round for forty minutes on 2026-09-13: the agents
    // returned before building an index they were able to serve, and the
    // viewer's Media tab told the operator to "use the hub".
    const a = src.indexOf('private async serveNcArtifactPlane(')
    expect(a).toBeGreaterThan(0)
    const body = src.slice(a, a + 6_000)
    const index = body.indexOf('this.ncArtifactIndex = index')
    const refusal = body.indexOf('artifactShelfRefusal(')
    expect(index).toBeGreaterThan(0)
    expect(refusal).toBeGreaterThan(0)
    expect(index).toBeLessThan(refusal)
  })
})
