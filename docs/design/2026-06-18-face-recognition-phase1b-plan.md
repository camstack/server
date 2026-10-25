# Face Recognition — Phase 1b (stores) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two persistent stores the recognition core needs in `addon-post-analysis`: `IdentityStore` (the enrolled gallery — identities + samples, plus `loadGallery()` for the matcher) and `FaceStore` (the bounded recent-unassigned-faces buffer for enrollment + retention). Pure store layer, modelled on the existing `EventStore`/`TrackStore`. No `FaceRecognizer`, no wiring — that is sub-plan 1c.

**Architecture:** Mirror `EventStore`/`TrackStore` verbatim: a class with `{ store: SettingsStoreClient, logger: IScopedLogger }` deps, a `static declare(store)` that registers typed collections, and CRUD methods over the `settingsStore` `insert`/`query`/`update`/`set`/`delete` mutations. Embeddings persist as JSON `number[]` (normalized; ~512 floats, small). `loadGallery()` projects samples onto the `GallerySample` shape the Phase-1a matcher consumes.

**Tech Stack:** TypeScript 5.9 (strict, ESM NodeNext, `.js` imports), vitest, `@camstack/types`, `crypto.randomUUID()` for ids.

## Global Constraints

- **Data model (verbatim, spec §5):**
  - `pipeline-analytics:identities` — `id` (PK), `name`, `createdAt`, `updatedAt`, `sampleCount`, `coverMediaKey?`.
  - `pipeline-analytics:identity-samples` — `id` (PK), `identityId` (index), `embedding` (JSON, normalized), `mediaKey` (crop), `source` (`'detected'|'photo'`), `deviceId?`, `modelId`, `dim`, `addedAt`.
  - `pipeline-analytics:faces` (recent unassigned buffer) — `id` (PK), `deviceId`, `trackId` (index), `timestamp`, `embedding` (JSON), `mediaKey` (crop), `recognizedIdentityId?`, `assigned` (bool). **One entry per track** (best face), bounded by retention + per-device cap.
- **settingsStore API shapes (verbatim — match the real `SettingsStoreClient`):** `declareCollection.mutate({ collection, columns, indexes })`; `insert.mutate({ collection, record: { id, data } })`; `query.query({ collection, filter })` → `{ id, data }[]` where `filter` supports `{ where, whereBetween, orderBy: { field, direction }, limit, offset }`; `update.mutate({ collection, id, data })`; `set.mutate({ collection, key, value })`; `delete.mutate({ collection, key })`. Column `{ name, type: 'TEXT'|'INTEGER'|'REAL'|'JSON', primaryKey?, notNull? }`; index `{ name, columns }`.
- **`loadGallery()` returns `readonly GallerySample[]`** (the Phase-1a type: `{ identityId, embedding: readonly number[], modelId }`). Skip samples missing `embedding`/`modelId`. (Perf note: 1c will wrap embeddings into `Float32Array` once at gallery-build time — do NOT change the matcher API here.)
- **Best-effort writes:** wrap each store mutation in try/catch + `logger.warn`, like `EventStore.insertObject`. Queries may throw (caller handles) unless noted.
- **Immutability:** never mutate inputs; build new row objects.
- **`source` default:** `addSample` defaults `source` to `'detected'` (photo enrollment is Phase 4).
- **ESM `.js` imports; strict TS.** Type gate: `cd packages/addon-post-analysis && npx tsc --noEmit` clean.
- **Commit:** `git commit --no-verify`; conventional commits, no attribution trailers.
- **Test command:** `npx vitest run --exclude '**/.claude/**' <files>` from repo root.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts` | Enrolled gallery: identities + samples; `loadGallery()`. | Create. |
| `packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts` | Recent-unassigned-faces buffer + retention prune. | Create. |
| `…/__tests__/identity-store.spec.ts`, `…/__tests__/face-store.spec.ts` | New unit specs (mirror `event-store.spec.ts`). | Create. |

**Interfaces produced (consumed by 1c):**
- `Identity`, `IdentitySample`, `IdentityStore` with: `static declare(store)`, `createIdentity({name})`, `renameIdentity(id, name)`, `deleteIdentity(id)`, `listIdentities()`, `addSample(input)`, `removeSample(identityId, sampleId)`, `loadGallery()`.
- `Face`, `FaceStore` with: `static declare(store)`, `insert(face)`, `listRecentFaces({deviceId?, limit?})`, `markAssigned(faceId, identityId)`, `prune({deviceId, cutoffMs, maxPerDevice})`.

---

### Task 1: IdentityStore — declare + identity CRUD

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts`
- Test: `packages/addon-post-analysis/src/pipeline-analytics/__tests__/identity-store.spec.ts`

**Interfaces:**
- Consumes: `SettingsStoreClient`, `IScopedLogger` from `@camstack/types`; the test fake `makeFakeSettingsStore`/`makeSilentLogger` from `./test-helpers.js` (read its real exports first).
- Produces: `Identity`, `IdentityStore.declare`, `createIdentity`, `renameIdentity`, `deleteIdentity`, `listIdentities`. (`deleteIdentity` already cascades sample rows via a query+delete, so it works before `addSample` lands in Task 2.)

- [ ] **Step 1: Write the failing test**

Create `identity-store.spec.ts` (mirror `event-store.spec.ts` setup — read it for the real `makeFakeSettingsStore`/`makeSilentLogger` import path + `fake.client`/`fake.declared` shape):

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { IdentityStore, IDENTITIES_COLLECTION, IDENTITY_SAMPLES_COLLECTION } from '../store/identity-store.js'
import { makeFakeSettingsStore, makeSilentLogger } from './test-helpers.js'

describe('IdentityStore — identities CRUD', () => {
  let fake: ReturnType<typeof makeFakeSettingsStore>
  let store: IdentityStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new IdentityStore({ store: fake.client, logger: makeSilentLogger() })
    await IdentityStore.declare(fake.client)
  })

  it('declares the identities + identity-samples collections', () => {
    expect(fake.declared.has(IDENTITIES_COLLECTION)).toBe(true)
    expect(fake.declared.has(IDENTITY_SAMPLES_COLLECTION)).toBe(true)
  })

  it('creates an identity with id, timestamps, zero samples', async () => {
    const id = await store.createIdentity({ name: 'Alice' })
    expect(id.name).toBe('Alice')
    expect(id.sampleCount).toBe(0)
    expect(typeof id.id).toBe('string')
    expect(id.createdAt).toBeGreaterThan(0)

    const all = await store.listIdentities()
    expect(all.map((i) => i.name)).toEqual(['Alice'])
  })

  it('renames an identity and bumps updatedAt', async () => {
    const id = await store.createIdentity({ name: 'Alice' })
    await store.renameIdentity(id.id, 'Alicia')
    const all = await store.listIdentities()
    expect(all.find((i) => i.id === id.id)?.name).toBe('Alicia')
  })

  it('deletes an identity', async () => {
    const a = await store.createIdentity({ name: 'Alice' })
    const b = await store.createIdentity({ name: 'Bob' })
    await store.deleteIdentity(a.id)
    const all = await store.listIdentities()
    expect(all.map((i) => i.name)).toEqual(['Bob'])
    expect(all.map((i) => i.id)).toEqual([b.id])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/identity-store.spec.ts`
Expected: FAIL — module `../store/identity-store.js` not found.

- [ ] **Step 3: Implement `identity-store.ts` (declare + identity CRUD)**

```typescript
import { randomUUID } from 'node:crypto'
import type { SettingsStoreClient, IScopedLogger } from '@camstack/types'

export const IDENTITIES_COLLECTION = 'pipeline-analytics:identities'
export const IDENTITY_SAMPLES_COLLECTION = 'pipeline-analytics:identity-samples'

const IDENTITY_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'name', type: 'TEXT' as const, notNull: true },
  { name: 'createdAt', type: 'INTEGER' as const, notNull: true },
  { name: 'updatedAt', type: 'INTEGER' as const, notNull: true },
  { name: 'sampleCount', type: 'INTEGER' as const, notNull: true },
  { name: 'coverMediaKey', type: 'TEXT' as const },
] as const

const SAMPLE_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'identityId', type: 'TEXT' as const, notNull: true },
  { name: 'embedding', type: 'JSON' as const, notNull: true },
  { name: 'mediaKey', type: 'TEXT' as const },
  { name: 'source', type: 'TEXT' as const, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const },
  { name: 'modelId', type: 'TEXT' as const, notNull: true },
  { name: 'dim', type: 'INTEGER' as const, notNull: true },
  { name: 'addedAt', type: 'INTEGER' as const, notNull: true },
] as const

export interface Identity {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly sampleCount: number
  readonly coverMediaKey?: string
}

export interface IdentityStoreDeps {
  readonly store: SettingsStoreClient
  readonly logger: IScopedLogger
}

export class IdentityStore {
  private readonly store: SettingsStoreClient
  private readonly logger: IScopedLogger

  constructor(deps: IdentityStoreDeps) {
    this.store = deps.store
    this.logger = deps.logger
  }

  static async declare(store: SettingsStoreClient): Promise<void> {
    await store.declareCollection.mutate({
      collection: IDENTITIES_COLLECTION,
      columns: [...IDENTITY_COLUMNS],
      indexes: [],
    })
    await store.declareCollection.mutate({
      collection: IDENTITY_SAMPLES_COLLECTION,
      columns: [...SAMPLE_COLUMNS],
      indexes: [{ name: 'idx_sample_identity', columns: ['identityId'] as const }],
    })
  }

  async createIdentity(input: { name: string }): Promise<Identity> {
    const now = Date.now()
    const identity: Identity = {
      id: randomUUID(),
      name: input.name,
      createdAt: now,
      updatedAt: now,
      sampleCount: 0,
    }
    const { id, ...rest } = identity
    await this.store.insert.mutate({
      collection: IDENTITIES_COLLECTION,
      record: { id, data: rest as unknown as Record<string, unknown> },
    })
    return identity
  }

  async renameIdentity(id: string, name: string): Promise<void> {
    await this.store.update.mutate({
      collection: IDENTITIES_COLLECTION,
      id,
      data: { name, updatedAt: Date.now() },
    })
  }

  async deleteIdentity(id: string): Promise<void> {
    // Cascade: remove the identity's samples first, then the identity row.
    const samples = await this.store.query.query({
      collection: IDENTITY_SAMPLES_COLLECTION,
      filter: { where: { identityId: id } },
    })
    for (const s of samples) {
      try {
        await this.store.delete.mutate({ collection: IDENTITY_SAMPLES_COLLECTION, key: s.id })
      } catch (err) {
        this.logger.warn('deleteIdentity sample delete failed', { meta: { id, sampleId: s.id, error: String(err) } })
      }
    }
    await this.store.delete.mutate({ collection: IDENTITIES_COLLECTION, key: id })
  }

  async listIdentities(): Promise<readonly Identity[]> {
    const rows = await this.store.query.query({
      collection: IDENTITIES_COLLECTION,
      filter: { orderBy: { field: 'createdAt', direction: 'asc' } },
    })
    return rows.map((r) => ({ id: r.id, ...(r.data as Omit<Identity, 'id'>) }))
  }
}
```

> Read the real `event-store.spec.ts` for the exact `makeFakeSettingsStore` return shape (`fake.client`, `fake.declared`) and adapt the test imports. If the fake lacks `orderBy` support for the `listIdentities` filter, the existing event-store relies on it — confirm it's there; if not, query without `orderBy` and sort in JS.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/identity-store.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/identity-store.spec.ts
git commit --no-verify -m "feat(post-analysis): IdentityStore — declare + identity CRUD"
```

---

### Task 2: IdentityStore — samples + loadGallery

**Files:**
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts`
- Test: `…/__tests__/identity-store.spec.ts` (append)

**Interfaces:**
- Consumes: Task 1 `IdentityStore`; `GallerySample` from `../pipeline/face-matcher.js`.
- Produces: `IdentitySample`, `addSample`, `removeSample`, `loadGallery`.

- [ ] **Step 1: Write the failing tests**

Append to `identity-store.spec.ts`:

```typescript
import type { GallerySample } from '../pipeline/face-matcher.js'

describe('IdentityStore — samples + gallery', () => {
  let fake: ReturnType<typeof makeFakeSettingsStore>
  let store: IdentityStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new IdentityStore({ store: fake.client, logger: makeSilentLogger() })
    await IdentityStore.declare(fake.client)
  })

  it('adds a sample, bumps sampleCount, sets cover on the first', async () => {
    const id = await store.createIdentity({ name: 'Alice' })
    const s = await store.addSample({
      identityId: id.id, embedding: [0.1, 0.2, 0.3, 0.4],
      mediaKey: 'face:f1:crop:1000', modelId: 'arcface-r100', deviceId: 7,
    })
    expect(s.dim).toBe(4)
    expect(s.source).toBe('detected')

    const after = (await store.listIdentities()).find((i) => i.id === id.id)
    expect(after?.sampleCount).toBe(1)
    expect(after?.coverMediaKey).toBe('face:f1:crop:1000')
  })

  it('removeSample decrements sampleCount', async () => {
    const id = await store.createIdentity({ name: 'Alice' })
    const s1 = await store.addSample({ identityId: id.id, embedding: [1, 0], mediaKey: 'm1', modelId: 'arcface-r100' })
    await store.addSample({ identityId: id.id, embedding: [0, 1], mediaKey: 'm2', modelId: 'arcface-r100' })
    await store.removeSample(id.id, s1.id)
    expect((await store.listIdentities()).find((i) => i.id === id.id)?.sampleCount).toBe(1)
  })

  it('loadGallery projects every sample onto GallerySample', async () => {
    const a = await store.createIdentity({ name: 'Alice' })
    const b = await store.createIdentity({ name: 'Bob' })
    await store.addSample({ identityId: a.id, embedding: [1, 0], mediaKey: 'm1', modelId: 'arcface-r100' })
    await store.addSample({ identityId: b.id, embedding: [0, 1], mediaKey: 'm2', modelId: 'arcface-r100' })

    const gallery: readonly GallerySample[] = await store.loadGallery()
    expect(gallery).toHaveLength(2)
    expect(gallery.every((g) => g.modelId === 'arcface-r100')).toBe(true)
    expect(new Set(gallery.map((g) => g.identityId))).toEqual(new Set([a.id, b.id]))
  })

  it('deleteIdentity removes its samples from the gallery', async () => {
    const a = await store.createIdentity({ name: 'Alice' })
    await store.addSample({ identityId: a.id, embedding: [1, 0], mediaKey: 'm1', modelId: 'arcface-r100' })
    await store.deleteIdentity(a.id)
    expect(await store.loadGallery()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/identity-store.spec.ts`
Expected: FAIL — `addSample`/`removeSample`/`loadGallery` not defined.

- [ ] **Step 3: Implement samples + loadGallery**

Add the import at the top of `identity-store.ts`:

```typescript
import type { GallerySample } from '../pipeline/face-matcher.js'
```

Add the `IdentitySample` interface near `Identity`:

```typescript
export interface IdentitySample {
  readonly id: string
  readonly identityId: string
  readonly embedding: readonly number[]
  readonly mediaKey?: string
  readonly source: 'detected' | 'photo'
  readonly deviceId?: number
  readonly modelId: string
  readonly dim: number
  readonly addedAt: number
}
```

Add these methods to `IdentityStore`:

```typescript
async addSample(input: {
  identityId: string
  embedding: readonly number[]
  mediaKey?: string
  modelId: string
  source?: 'detected' | 'photo'
  deviceId?: number
}): Promise<IdentitySample> {
  const sample: IdentitySample = {
    id: randomUUID(),
    identityId: input.identityId,
    embedding: input.embedding,
    ...(input.mediaKey !== undefined ? { mediaKey: input.mediaKey } : {}),
    source: input.source ?? 'detected',
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    modelId: input.modelId,
    dim: input.embedding.length,
    addedAt: Date.now(),
  }
  const { id, ...rest } = sample
  await this.store.insert.mutate({
    collection: IDENTITY_SAMPLES_COLLECTION,
    record: { id, data: rest as unknown as Record<string, unknown> },
  })
  // Bump the parent identity: sampleCount + updatedAt; set cover on first sample.
  const identity = (await this.listIdentities()).find((i) => i.id === input.identityId)
  if (identity) {
    const patch: Record<string, unknown> = {
      sampleCount: identity.sampleCount + 1,
      updatedAt: Date.now(),
    }
    if (identity.coverMediaKey === undefined && input.mediaKey !== undefined) {
      patch['coverMediaKey'] = input.mediaKey
    }
    await this.store.update.mutate({ collection: IDENTITIES_COLLECTION, id: input.identityId, data: patch })
  }
  return sample
}

async removeSample(identityId: string, sampleId: string): Promise<void> {
  await this.store.delete.mutate({ collection: IDENTITY_SAMPLES_COLLECTION, key: sampleId })
  const identity = (await this.listIdentities()).find((i) => i.id === identityId)
  if (identity) {
    await this.store.update.mutate({
      collection: IDENTITIES_COLLECTION,
      id: identityId,
      data: { sampleCount: Math.max(0, identity.sampleCount - 1), updatedAt: Date.now() },
    })
  }
}

/**
 * Build the in-memory matching gallery from every persisted sample. Samples
 * missing an embedding or modelId are skipped (defensive). The matcher itself
 * filters by modelId/dim per probe, so all models can coexist here.
 */
async loadGallery(): Promise<readonly GallerySample[]> {
  const rows = await this.store.query.query({ collection: IDENTITY_SAMPLES_COLLECTION, filter: {} })
  const gallery: GallerySample[] = []
  for (const r of rows) {
    const d = r.data as Partial<IdentitySample>
    if (!Array.isArray(d.embedding) || typeof d.modelId !== 'string' || typeof d.identityId !== 'string') continue
    gallery.push({ identityId: d.identityId, embedding: d.embedding, modelId: d.modelId })
  }
  return gallery
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/identity-store.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/identity-store.spec.ts
git commit --no-verify -m "feat(post-analysis): IdentityStore — samples (add/remove) + loadGallery"
```

---

### Task 3: FaceStore — declare + insert + listRecentFaces + markAssigned

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts`
- Test: `…/__tests__/face-store.spec.ts`

**Interfaces:**
- Consumes: `SettingsStoreClient`, `IScopedLogger`.
- Produces: `Face`, `FaceStore.declare`, `insert`, `listRecentFaces`, `markAssigned`.

- [ ] **Step 1: Write the failing test**

Create `face-store.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { FaceStore, FACES_COLLECTION, type Face } from '../store/face-store.js'
import { makeFakeSettingsStore, makeSilentLogger } from './test-helpers.js'

function face(id: string, deviceId: number, trackId: string, ts: number, assigned = false): Face {
  return {
    id, deviceId, trackId, timestamp: ts,
    embedding: [0.1, 0.2], mediaKey: `face:${id}:crop:${ts}`, assigned,
  }
}

describe('FaceStore', () => {
  let fake: ReturnType<typeof makeFakeSettingsStore>
  let store: FaceStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new FaceStore({ store: fake.client, logger: makeSilentLogger() })
    await FaceStore.declare(fake.client)
  })

  it('declares the faces collection', () => {
    expect(fake.declared.has(FACES_COLLECTION)).toBe(true)
  })

  it('insert is upsert-by-id (one entry per track)', async () => {
    await store.insert(face('t1', 7, 't1', 1000))
    await store.insert(face('t1', 7, 't1', 2000)) // same id → replaces
    const recent = await store.listRecentFaces({ deviceId: 7 })
    expect(recent).toHaveLength(1)
    expect(recent[0]!.timestamp).toBe(2000)
  })

  it('listRecentFaces returns only UNASSIGNED faces, newest first, honoring limit', async () => {
    await store.insert(face('a', 7, 'a', 1000))
    await store.insert(face('b', 7, 'b', 3000))
    await store.insert(face('c', 7, 'c', 2000, true)) // assigned → excluded
    const recent = await store.listRecentFaces({ deviceId: 7, limit: 10 })
    expect(recent.map((f) => f.id)).toEqual(['b', 'a'])
  })

  it('markAssigned flips assigned + sets recognizedIdentityId', async () => {
    await store.insert(face('a', 7, 'a', 1000))
    await store.markAssigned('a', 'identity-1')
    const recent = await store.listRecentFaces({ deviceId: 7 })
    expect(recent).toHaveLength(0) // now assigned → excluded from the buffer
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-store.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `face-store.ts`**

```typescript
import type { SettingsStoreClient, IScopedLogger } from '@camstack/types'

export const FACES_COLLECTION = 'pipeline-analytics:faces'

const FACE_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'trackId', type: 'TEXT' as const, notNull: true },
  { name: 'timestamp', type: 'INTEGER' as const, notNull: true },
  { name: 'embedding', type: 'JSON' as const, notNull: true },
  { name: 'mediaKey', type: 'TEXT' as const },
  { name: 'recognizedIdentityId', type: 'TEXT' as const },
  { name: 'assigned', type: 'INTEGER' as const, notNull: true },
] as const

const FACE_INDEXES = [
  { name: 'idx_faces_device_ts', columns: ['deviceId', 'timestamp'] as const },
  { name: 'idx_faces_track', columns: ['trackId'] as const },
] as const

export interface Face {
  readonly id: string
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly embedding: readonly number[]
  readonly mediaKey?: string
  readonly recognizedIdentityId?: string
  readonly assigned: boolean
}

export interface FaceStoreDeps {
  readonly store: SettingsStoreClient
  readonly logger: IScopedLogger
}

export class FaceStore {
  private readonly store: SettingsStoreClient
  private readonly logger: IScopedLogger

  constructor(deps: FaceStoreDeps) {
    this.store = deps.store
    this.logger = deps.logger
  }

  static async declare(store: SettingsStoreClient): Promise<void> {
    await store.declareCollection.mutate({
      collection: FACES_COLLECTION,
      columns: [...FACE_COLUMNS],
      indexes: [...FACE_INDEXES],
    })
  }

  /** Upsert one buffered face. Keyed by `face.id` (the worker uses one stable
   *  id per track → one entry per track). `set` replaces an existing row. */
  async insert(face: Face): Promise<void> {
    const { id, ...rest } = face
    try {
      await this.store.set.mutate({
        collection: FACES_COLLECTION,
        key: id,
        value: rest as unknown as Record<string, unknown>,
      })
    } catch (err) {
      this.logger.warn('FaceStore.insert failed', { meta: { faceId: id, error: String(err) } })
    }
  }

  /** Recent UNASSIGNED faces (the enrollment buffer), newest first. */
  async listRecentFaces(input: { deviceId?: number; limit?: number }): Promise<readonly Face[]> {
    const where: Record<string, unknown> = {}
    if (input.deviceId !== undefined) where['deviceId'] = input.deviceId
    const rows = await this.store.query.query({
      collection: FACES_COLLECTION,
      filter: {
        where,
        orderBy: { field: 'timestamp', direction: 'desc' },
        limit: input.limit ?? 100,
      },
    })
    return rows
      .map((r) => ({ id: r.id, ...(r.data as Omit<Face, 'id'>) }))
      .filter((f) => !f.assigned)
  }

  async markAssigned(faceId: string, identityId: string): Promise<void> {
    try {
      await this.store.update.mutate({
        collection: FACES_COLLECTION,
        id: faceId,
        data: { assigned: true, recognizedIdentityId: identityId },
      })
    } catch (err) {
      this.logger.warn('FaceStore.markAssigned failed', { meta: { faceId, error: String(err) } })
    }
  }
}
```

> NOTE: `assigned` is declared `INTEGER` (0/1) for SQLite but the `Face` type uses `boolean` and the fake store round-trips the JS value verbatim. The real backend coerces boolean→integer on write and the read returns the stored value; if the real backend returns `1`/`0` rather than `true`/`false`, normalize in the map (`assigned: Boolean(f.assigned)`). Verify against the real backend's JSON/boolean handling; if in doubt, store `assigned` as a JSON boolean column instead. The test uses the fake (verbatim round-trip) so it passes either way — flag this for the reviewer.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-store.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-store.spec.ts
git commit --no-verify -m "feat(post-analysis): FaceStore — declare + insert + listRecentFaces + markAssigned"
```

---

### Task 4: FaceStore — retention prune (age + per-device cap)

**Files:**
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts`
- Test: `…/__tests__/face-store.spec.ts` (append)

**Interfaces:**
- Consumes: Task 3 `FaceStore`.
- Produces: `prune({ deviceId, cutoffMs, maxPerDevice }): Promise<readonly string[]>` — deletes faces older than `cutoffMs` OR beyond the newest `maxPerDevice` for the device; returns deleted face ids (so the caller can delete their crops via `MediaStore.deleteForOwner('face', ids)`).

- [ ] **Step 1: Write the failing tests**

Append to `face-store.spec.ts`:

```typescript
describe('FaceStore — prune', () => {
  let fake: ReturnType<typeof makeFakeSettingsStore>
  let store: FaceStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    store = new FaceStore({ store: fake.client, logger: makeSilentLogger() })
    await FaceStore.declare(fake.client)
  })

  it('prunes faces older than cutoff and returns their ids', async () => {
    await store.insert(face('old', 7, 'old', 1000))
    await store.insert(face('new', 7, 'new', 5000))
    const deleted = await store.prune({ deviceId: 7, cutoffMs: 3000, maxPerDevice: 100 })
    expect(deleted).toEqual(['old'])
    expect((await store.listRecentFaces({ deviceId: 7 })).map((f) => f.id)).toEqual(['new'])
  })

  it('enforces the per-device cap, keeping the newest', async () => {
    for (let i = 0; i < 5; i++) await store.insert(face(`f${i}`, 7, `f${i}`, 1000 + i))
    const deleted = await store.prune({ deviceId: 7, cutoffMs: 0, maxPerDevice: 2 })
    // keeps f4, f3 (newest 2); deletes f0,f1,f2
    expect(new Set(deleted)).toEqual(new Set(['f0', 'f1', 'f2']))
    expect((await store.listRecentFaces({ deviceId: 7 })).map((f) => f.id)).toEqual(['f4', 'f3'])
  })

  it('does not touch another device', async () => {
    await store.insert(face('a', 7, 'a', 1000))
    await store.insert(face('b', 99, 'b', 1000))
    await store.prune({ deviceId: 7, cutoffMs: 5000, maxPerDevice: 0 })
    expect((await store.listRecentFaces({ deviceId: 99 })).map((f) => f.id)).toEqual(['b'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-store.spec.ts`
Expected: FAIL — `prune` not defined.

- [ ] **Step 3: Implement `prune`**

Add to `FaceStore`:

```typescript
/**
 * Retention for one device: delete faces older than `cutoffMs` AND any beyond
 * the newest `maxPerDevice`. Returns deleted ids so the caller removes their
 * crops (MediaStore.deleteForOwner('face', ids)). Reads all of the device's
 * rows (the buffer is small + capped), decides in memory, deletes best-effort.
 */
async prune(input: { deviceId: number; cutoffMs: number; maxPerDevice: number }): Promise<readonly string[]> {
  const rows = await this.store.query.query({
    collection: FACES_COLLECTION,
    filter: { where: { deviceId: input.deviceId }, orderBy: { field: 'timestamp', direction: 'desc' } },
  })
  const ordered = rows.map((r) => ({ id: r.id, timestamp: Number((r.data as { timestamp?: unknown }).timestamp ?? 0) }))
  const toDelete = new Set<string>()
  ordered.forEach((row, idx) => {
    if (row.timestamp < input.cutoffMs) toDelete.add(row.id) // too old
    if (idx >= input.maxPerDevice) toDelete.add(row.id)       // beyond the cap (rows are newest-first)
  })
  const deleted: string[] = []
  for (const id of toDelete) {
    try {
      await this.store.delete.mutate({ collection: FACES_COLLECTION, key: id })
      deleted.push(id)
    } catch (err) {
      this.logger.warn('FaceStore.prune delete failed', { meta: { faceId: id, error: String(err) } })
    }
  }
  return deleted
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-store.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-store.spec.ts
git commit --no-verify -m "feat(post-analysis): FaceStore — retention prune (age + per-device cap)"
```

---

### Task 5: Verify the package

**Files:** none (verify only).

- [ ] **Step 1: Typecheck**

Run: `cd packages/addon-post-analysis && npx tsc --noEmit`
Expected: clean. Return to repo root.

- [ ] **Step 2: Full pipeline-analytics suite (no regressions)**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics`
Expected: all pass (existing + identity-store + face-store).

> No deploy in 1b — stores are dormant until the `FaceRecognizer` + wiring land in 1c.

---

## Self-Review

**Spec coverage (spec §5 data model + §4 components 3 & 4):**
- `IdentityStore` (identities + identity-samples, gallery load) → Tasks 1–2. ✅
- `FaceStore` (recent-unassigned buffer, one-per-track, retention by age + per-device cap) → Tasks 3–4. ✅
- `loadGallery()` → `GallerySample[]` consumed by the Phase-1a matcher. ✅
- Crop media for samples/faces is referenced by `mediaKey` (the `'face'` ownerKind from Phase-1a Task 4); the worker that writes those crops + calls these stores is 1c.

**Placeholder scan:** all code complete. Two flagged NOTE/verify directives (the `makeFakeSettingsStore` shape in Task 1; the `assigned` boolean/integer round-trip in Task 3) instruct the implementer to verify against real code — not vague TODOs. Flagged for the reviewer.

**Type consistency:** `Identity`/`IdentitySample`/`Face` field names match the spec §5 columns and the collection column definitions. `loadGallery` returns `GallerySample` (Phase-1a) exactly. `prune` returns `readonly string[]` (deleted ids) as the produced-interface block states; the 1c retention hook will feed them to `MediaStore.deleteForOwner('face', ids)`.

**Reviewer recommendations carried from 1a:** `loadGallery` returns `number[]` embeddings (unchanged matcher API); 1c will wrap to `Float32Array` once at gallery-build time — NOT done here to avoid churning the shipped matcher signature. Recorded for 1c.

**Deferred to 1c (named, not gaps):** the `FaceRecognizer` worker, the per-frame wiring in `index.ts`, the retention-sweep hook that calls `FaceStore.prune` + `MediaStore.deleteForOwner('face', …)` + `resolveDeviceFaceSettings` cache, gallery refresh on enroll/delete, and best-face crop capture.
