import { beforeEach, describe, expect, it } from 'vitest'
import type { InMemoryRecords } from '@camstack/types'
import { makeNcRecords, ncTable } from './support/nc-test-deps.js'
import {
  artifactDownloadPath,
  artifactKindForMediaType,
  mediaTypeForMime,
  NC_GALLERY_ARTIFACT_KINDS,
  NcArtifactIndex,
  type NcArtifactIndexInput,
  type NcArtifactViewer,
} from '../artifact-index.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'

const RETENTION_MS = 14 * 24 * 3600_000
const ADMIN: NcArtifactViewer = { userId: 'root', isAdmin: true }
const ALICE: NcArtifactViewer = { userId: 'alice', isAdmin: false }
const BOB: NcArtifactViewer = { userId: 'bob', isAdmin: false }

let world: InMemoryRecords
let clock = 1_700_000_000_000

function makeIndex(): NcArtifactIndex {
  return new NcArtifactIndex({
    records: world.records,
    logger: makeSilentLogger(),
    addonId: 'pipeline-analytics',
    retentionMs: RETENTION_MS,
    now: () => clock,
  })
}

function input(overrides: Partial<NcArtifactIndexInput> = {}): NcArtifactIndexInput {
  return {
    id: `${clock}-3f2504e0-4f89-11d3-9a0c-0305e82c3301`,
    kind: 'timelapse',
    mime: 'video/mp4',
    sizeBytes: 1024,
    capturedAt: clock,
    deviceId: 102,
    deviceIds: [102],
    ...overrides,
  }
}

/** Sequential ids so ordering assertions are unambiguous. */
let seq = 0
const nextId = (): string =>
  `${clock}-3f2504e0-4f89-11d3-9a0c-0305e82c33${String((seq += 1) % 100).padStart(2, '0')}`

beforeEach(async () => {
  world = makeNcRecords()
  clock = 1_700_000_000_000
  seq = 0
})

describe('NcArtifactIndex — derived fields', () => {
  it('maps a notification attachment mediaType onto a gallery kind', () => {
    expect(artifactKindForMediaType('image')).toBe('event-still')
    expect(artifactKindForMediaType('gif')).toBe('event-gif')
    expect(artifactKindForMediaType('video')).toBe('event-clip')
  })

  it('derives mediaType from the mime the bytes ACTUALLY are', () => {
    expect(mediaTypeForMime('image/gif')).toBe('gif')
    expect(mediaTypeForMime('video/mp4')).toBe('video')
    expect(mediaTypeForMime('image/jpeg')).toBe('image')
    expect(mediaTypeForMime('image/png')).toBe('image')
  })

  it('builds the relative authenticated bytes path', () => {
    expect(artifactDownloadPath('pipeline-analytics', 'abc')).toBe(
      '/addon/pipeline-analytics/nc-artifact-read/abc',
    )
  })

  it('derives expiresAt from the shelf retention, not a second policy', async () => {
    const index = makeIndex()
    const rec = await index.record(input())
    expect(rec?.expiresAt).toBe(clock + RETENTION_MS)
    expect(rec?.createdAt).toBe(clock)
    expect(rec?.downloadPath).toBe(`/addon/pipeline-analytics/nc-artifact-read/${rec?.id ?? ''}`)
  })
})

describe('NcArtifactIndex — record + get', () => {
  it('round-trips one artefact', async () => {
    const index = makeIndex()
    const written = await index.record(
      input({ ruleId: 'r1', ruleName: 'Notte', title: 'Garden', deviceIds: [102, 108] }),
    )
    expect(written).not.toBeNull()
    const read = await index.get(written?.id ?? '', ADMIN)
    expect(read).toEqual(written)
    expect(read?.deviceIds).toEqual([102, 108])
    expect(read?.mediaType).toBe('video')
  })

  it('answers null for an unknown id', async () => {
    const index = makeIndex()
    expect(await index.get('nope', ADMIN)).toBeNull()
  })

  it('answers null once the bytes have expired', async () => {
    const index = makeIndex()
    const rec = await index.record(input())
    clock += RETENTION_MS + 1
    expect(await index.get(rec?.id ?? '', ADMIN)).toBeNull()
  })

  // "not yours" and "not there" must be indistinguishable.
  it('hides another user personal artefact behind the same null', async () => {
    const index = makeIndex()
    const rec = await index.record(input({ ownerUserId: 'alice' }))
    expect(await index.get(rec?.id ?? '', BOB)).toBeNull()
    expect(await index.get(rec?.id ?? '', ALICE)).not.toBeNull()
    expect(await index.get(rec?.id ?? '', ADMIN)).not.toBeNull()
  })

  // The bytes route is served `authenticated`; it resolves an id it was handed,
  // it does not re-litigate ownership.
  it('resolve() ignores visibility — it is the bytes route lookup', async () => {
    const index = makeIndex()
    const rec = await index.record(input({ ownerUserId: 'alice' }))
    expect(await index.resolve(rec?.id ?? '')).not.toBeNull()
    expect(await index.resolve('nope')).toBeNull()
  })
})

describe('NcArtifactIndex — list', () => {
  it('orders by capturedAt, newest first', async () => {
    const index = makeIndex()
    await index.record(input({ id: nextId(), capturedAt: 100 }))
    await index.record(input({ id: nextId(), capturedAt: 300 }))
    await index.record(input({ id: nextId(), capturedAt: 200 }))
    const page = await index.list({ limit: 50, offset: 0 }, ADMIN)
    expect(page.artifacts.map((a) => a.capturedAt)).toEqual([300, 200, 100])
    expect(page.total).toBe(3)
    expect(page.hasMore).toBe(false)
  })

  it('paginates with a total that counts the whole match, not the page', async () => {
    const index = makeIndex()
    for (const at of [100, 200, 300, 400, 500]) {
      await index.record(input({ id: nextId(), capturedAt: at }))
    }
    const first = await index.list({ limit: 2, offset: 0 }, ADMIN)
    expect(first.artifacts.map((a) => a.capturedAt)).toEqual([500, 400])
    expect(first.total).toBe(5)
    expect(first.hasMore).toBe(true)
    const last = await index.list({ limit: 2, offset: 4 }, ADMIN)
    expect(last.artifacts.map((a) => a.capturedAt)).toEqual([100])
    expect(last.hasMore).toBe(false)
  })

  it('filters by kind', async () => {
    const index = makeIndex()
    await index.record(input({ id: nextId(), kind: 'timelapse', capturedAt: 100 }))
    await index.record(
      input({ id: nextId(), kind: 'summary-mosaic', mime: 'image/jpeg', capturedAt: 200 }),
    )
    const page = await index.list({ limit: 50, offset: 0, kinds: ['summary-mosaic'] }, ADMIN)
    expect(page.artifacts).toHaveLength(1)
    expect(page.artifacts[0]?.kind).toBe('summary-mosaic')
    expect(page.total).toBe(1)
  })

  it('omits poster kinds from an unfiltered list', async () => {
    const index = makeIndex()
    await index.record(input({ id: nextId(), kind: 'timelapse', capturedAt: 300 }))
    await index.record(
      input({
        id: nextId(),
        kind: 'timelapse-preview',
        mime: 'image/jpeg',
        capturedAt: 200,
      }),
    )
    await index.record(
      input({ id: nextId(), kind: 'event-still', mime: 'image/jpeg', capturedAt: 100 }),
    )
    const page = await index.list({ limit: 50, offset: 0 }, ADMIN)
    expect(page.artifacts.map((a) => a.kind)).toEqual(['timelapse'])
    expect(page.total).toBe(1)
  })

  it('still answers a poster when the caller names that kind', async () => {
    const index = makeIndex()
    await index.record(
      input({ id: nextId(), kind: 'event-still', mime: 'image/jpeg', capturedAt: 100 }),
    )
    const page = await index.list({ limit: 50, offset: 0, kinds: ['event-still'] }, ADMIN)
    expect(page.artifacts).toHaveLength(1)
    expect(page.artifacts[0]?.kind).toBe('event-still')
  })

  it('the unfiltered default is exactly the gallery kinds', () => {
    expect([...NC_GALLERY_ARTIFACT_KINDS]).toEqual([
      'timelapse',
      'event-gif',
      'event-clip',
      'summary-mosaic',
    ])
  })

  it('filters by the camera the artefact is FILED under', async () => {
    const index = makeIndex()
    await index.record(input({ id: nextId(), deviceId: 102, deviceIds: [102] }))
    await index.record(input({ id: nextId(), deviceId: 108, deviceIds: [108, 102] }))
    const page = await index.list({ limit: 50, offset: 0, deviceIds: [108] }, ADMIN)
    expect(page.artifacts).toHaveLength(1)
    expect(page.artifacts[0]?.deviceId).toBe(108)
  })

  it('filters by rule', async () => {
    const index = makeIndex()
    await index.record(input({ id: nextId(), ruleId: 'r1' }))
    await index.record(input({ id: nextId(), ruleId: 'r2' }))
    const page = await index.list({ limit: 50, offset: 0, ruleId: 'r2' }, ADMIN)
    expect(page.artifacts).toHaveLength(1)
    expect(page.artifacts[0]?.ruleId).toBe('r2')
  })

  it('filters by an inclusive capturedAt window', async () => {
    const index = makeIndex()
    for (const at of [100, 200, 300]) {
      await index.record(input({ id: nextId(), capturedAt: at }))
    }
    const page = await index.list({ limit: 50, offset: 0, fromMs: 200, toMs: 300 }, ADMIN)
    expect(page.artifacts.map((a) => a.capturedAt)).toEqual([300, 200])
  })

  // Expiry is a PREDICATE: an expired row must not eat a slot of the page.
  it('excludes expired rows from the page AND from the total', async () => {
    const index = makeIndex()
    await index.record(input({ id: nextId(), capturedAt: 100 }))
    clock += RETENTION_MS
    await index.record(input({ id: nextId(), capturedAt: 200 }))
    clock += 1
    const page = await index.list({ limit: 50, offset: 0 }, ADMIN)
    expect(page.artifacts.map((a) => a.capturedAt)).toEqual([200])
    expect(page.total).toBe(1)
  })

  it('shows a caller global artefacts plus his own, never another user’s', async () => {
    const index = makeIndex()
    await index.record(input({ id: nextId(), capturedAt: 100 }))
    await index.record(input({ id: nextId(), capturedAt: 200, ownerUserId: 'alice' }))
    await index.record(input({ id: nextId(), capturedAt: 300, ownerUserId: 'bob' }))
    const forAlice = await index.list({ limit: 50, offset: 0 }, ALICE)
    expect(forAlice.artifacts.map((a) => a.capturedAt)).toEqual([200, 100])
    expect(forAlice.total).toBe(2)
    const forAdmin = await index.list({ limit: 50, offset: 0 }, ADMIN)
    expect(forAdmin.total).toBe(3)
  })
})

describe('NcArtifactIndex — prune', () => {
  it('drops expired rows', async () => {
    const index = makeIndex()
    const a = await index.record(input({ id: nextId() }))
    clock += RETENTION_MS + 1
    const removed = await index.prune([a?.id ?? ''])
    expect(removed).toBe(1)
    expect(ncTable(world, 'artifacts').size).toBe(0)
  })

  // A row can outlive its file when a byte/count bound bit before the age one.
  it('drops rows whose bytes the shelf no longer holds', async () => {
    const index = makeIndex()
    const a = await index.record(input({ id: nextId() }))
    const b = await index.record(input({ id: nextId() }))
    const removed = await index.prune([b?.id ?? ''])
    expect(removed).toBe(1)
    expect(await index.get(a?.id ?? '', ADMIN)).toBeNull()
    expect(await index.get(b?.id ?? '', ADMIN)).not.toBeNull()
  })

  /**
   * The one that would have wiped the library. The index is CENTRAL and the
   * shelf is LOCAL: a node that does not produce artefacts sees an empty shelf,
   * and reconciling against it reads every row as an orphan.
   */
  it('sweeps ONLY expired rows when the caller states it holds no shelf', async () => {
    const index = makeIndex()
    const a = await index.record(input({ id: nextId(), capturedAt: 100 }))
    clock += RETENTION_MS
    const b = await index.record(input({ id: nextId(), capturedAt: 200 }))
    clock += 1
    expect(await index.prune(null)).toBe(1)
    // The expired one went; the live one SURVIVED a caller with no bytes.
    expect(await index.get(a?.id ?? '', ADMIN)).toBeNull()
    expect(await index.get(b?.id ?? '', ADMIN)).not.toBeNull()
  })

  it('keeps everything the shelf still holds', async () => {
    const index = makeIndex()
    const a = await index.record(input({ id: nextId() }))
    const b = await index.record(input({ id: nextId() }))
    expect(await index.prune([a?.id ?? '', b?.id ?? ''])).toBe(0)
    expect(ncTable(world, 'artifacts').size).toBe(2)
  })
})
