# Face Recognition — Phase 1a (foundations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the independent, leaf-level foundations of the face-recognition core in `addon-post-analysis`: a per-device face-settings cascade, a pure face-matcher (cosine + threshold + margin + per-frame greedy uniqueness + per-track hysteresis), `MediaStore` support for a `'face'` owner kind, and forward-only label propagation (`EventStore.setLabelForTrack` + `TrackStore.setLabel`). No `FaceRecognizer`, no `IdentityStore`/`FaceStore`, no wiring — those are sub-plans 1b/1c. Every piece here is unit-testable in isolation.

**Architecture:** Mirror existing `pipeline-analytics` patterns exactly. Settings cascade mirrors `tracking-settings.ts`/`audio-detection-settings.ts` (zod schema + per-field `.catch(default)`). The matcher is a pure module like `label-utils.ts`. `MediaStore` gains a `'face'` ownerKind and a generic `deleteForOwner`. `EventStore`/`TrackStore` gain label-update methods using the existing `settingsStore` `update`/`set` mutations.

**Tech Stack:** TypeScript 5.9 (strict, ESM NodeNext, `.js` import extensions), vitest, zod, `@camstack/types` (`cosineSimilarity`).

## Global Constraints

- **Immutability:** pure functions return new objects; never mutate inputs (matcher takes `readonly` arrays and returns new state). Store methods mutate only the backing `settingsStore`, never their arguments.
- **Settings defaults (verbatim, from spec §9):** `enabled` default **false**; `similarityThreshold` (τ) **0.45**; `margin` **0.05**; `minFaceConfidence` **0.5**; `confirmFrames` (K) **2**; `bufferRetentionDays` **3**; `bufferMaxPerDevice` **50**. τ and margin are cosine on L2-normalized arcface vectors.
- **Cascade shape:** mirror `resolveAudioDetectionSettings` (concise `pick` helper, per-field `safeParse` → default). `FACE_DEFAULTS = FaceSettingsSchema.parse({})`.
- **Model-version safety:** the matcher only compares samples whose `modelId` equals the probe's `modelId` AND whose embedding length equals the probe's (mismatched samples are skipped, never compared).
- **`cosineSimilarity` signature:** `cosineSimilarity(a: Float32Array, b: Float32Array): number` from `@camstack/types`. Convert `readonly number[]` → `new Float32Array(arr)` at the call site.
- **Backward compatibility:** `MediaStore.deleteForEvents(ids)` MUST keep working (existing retention caller depends on it) — implement it as a thin wrapper over the new `deleteForOwner('event', ids)`.
- **ESM `.js` import extensions; strict TS.**
- **Type gate:** `cd packages/addon-post-analysis && npx tsc --noEmit` clean.
- **Commit:** `git commit --no-verify` (eslint pre-commit hook hangs); conventional commits, no attribution trailers.
- **Test command (always exclude the stale worktree):** `npx vitest run --exclude '**/.claude/**' <files>` from repo root.

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/addon-post-analysis/src/pipeline-analytics/face-settings.ts` | Face-recognition settings schema + per-field cascade resolver. | Create. |
| `packages/addon-post-analysis/src/pipeline-analytics/pipeline/face-matcher.ts` | Pure matching: single-embedding match, per-frame greedy uniqueness, per-track hysteresis reducer. | Create. |
| `packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts` | Media blobs + index. | Add `'face'` ownerKind; generic `deleteForOwner`; `deleteForEvents` becomes a wrapper. |
| `packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts` | Object/motion/audio events. | Add `setLabelForTrack(trackId, label)` (forward-only update of a track's object events). |
| `packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts` | Track lifecycle + persistence. | Add `setLabel(trackId, label)` (update active in-memory + persisted row). |
| `…/__tests__/face-settings.spec.ts`, `…/__tests__/face-matcher.spec.ts` | New unit specs. | Create. |
| `…/__tests__/media-store.spec.ts`, `…/__tests__/event-store.spec.ts`, `…/__tests__/track-store.spec.ts` | Existing specs. | Append tests for the new methods. |

**Interfaces produced (consumed by 1b/1c):**
- `FaceSettings` / `FaceSettingsSchema` / `FACE_DEFAULTS` / `resolveFaceSettings(raw: Record<string, unknown>): FaceSettings`.
- `matchEmbedding(probe, gallery, opts): FaceMatch | null`; `assignUniquePerFrame(candidates, gallery, opts): Map<string, FaceMatch>`; `updateTrackAggregate(prev, match, opts): { state: TrackAggregate; changed: boolean }`; types `GallerySample`, `FaceMatch`, `FaceCandidate`, `TrackAggregate`, `EMPTY_AGGREGATE`.
- `MediaStore.deleteForOwner(ownerKind: 'event'|'track'|'face', ownerIds): Promise<number>`; `MediaStore` accepts `ownerKind: 'face'` in `put`/`listByOwner`.
- `EventStore.setLabelForTrack(trackId: string, label: string): Promise<number>` (returns count updated).
- `TrackStore.setLabel(trackId: string, label: string): Promise<void>`.

---

### Task 1: Face-settings cascade

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/face-settings.ts`
- Test: `packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-settings.spec.ts`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces: `FaceSettings`, `FaceSettingsSchema`, `FACE_DEFAULTS`, `resolveFaceSettings`.

- [ ] **Step 1: Write the failing test**

Create `face-settings.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveFaceSettings, FACE_DEFAULTS } from '../face-settings.js'

describe('resolveFaceSettings', () => {
  it('returns all defaults for an empty blob', () => {
    expect(resolveFaceSettings({})).toEqual(FACE_DEFAULTS)
  })

  it('defaults are the spec values', () => {
    expect(FACE_DEFAULTS).toEqual({
      enabled: false,
      similarityThreshold: 0.45,
      margin: 0.05,
      minFaceConfidence: 0.5,
      confirmFrames: 2,
      bufferRetentionDays: 3,
      bufferMaxPerDevice: 50,
    })
  })

  it('honours valid overrides and keeps defaults for the rest', () => {
    const r = resolveFaceSettings({ enabled: true, similarityThreshold: 0.6 })
    expect(r.enabled).toBe(true)
    expect(r.similarityThreshold).toBe(0.6)
    expect(r.margin).toBe(FACE_DEFAULTS.margin)
    expect(r.confirmFrames).toBe(FACE_DEFAULTS.confirmFrames)
  })

  it('falls back per-field on invalid values', () => {
    const r = resolveFaceSettings({
      enabled: 'yes',            // wrong type
      similarityThreshold: 5,     // out of [0,1]
      margin: -1,                 // must be >= 0
      confirmFrames: 1.5,         // must be int
      bufferRetentionDays: 'no',  // wrong type
    })
    expect(r.enabled).toBe(FACE_DEFAULTS.enabled)
    expect(r.similarityThreshold).toBe(FACE_DEFAULTS.similarityThreshold)
    expect(r.margin).toBe(FACE_DEFAULTS.margin)
    expect(r.confirmFrames).toBe(FACE_DEFAULTS.confirmFrames)
    expect(r.bufferRetentionDays).toBe(FACE_DEFAULTS.bufferRetentionDays)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-settings.spec.ts`
Expected: FAIL — module `../face-settings.js` not found.

- [ ] **Step 3: Implement `face-settings.ts`**

```typescript
import { z } from 'zod'

/**
 * Per-device face-recognition settings. Cascade: a per-device override on top
 * of the global default, resolved per field (an invalid/missing value falls
 * back to its default — parse never throws). Mirrors `audio-detection-settings`.
 */
export const FaceSettingsSchema = z.object({
  /** Master switch. Off by default — opt-in per device / globally. */
  enabled: z.boolean().default(false),
  /** Cosine similarity (on L2-normalized arcface vectors) required to match. */
  similarityThreshold: z.number().min(0).max(1).default(0.45),
  /** Reject ambiguous matches: require best − secondBest ≥ margin. */
  margin: z.number().min(0).max(1).default(0.05),
  /** Minimum face-detection confidence for a face to be considered. */
  minFaceConfidence: z.number().min(0).max(1).default(0.5),
  /** Frames an identity must be confirmed before a track is assigned. */
  confirmFrames: z.number().int().min(1).default(2),
  /** Recent-faces buffer retention (days). */
  bufferRetentionDays: z.number().min(0).default(3),
  /** Max buffered faces kept per device. */
  bufferMaxPerDevice: z.number().int().min(0).default(50),
})

export type FaceSettings = z.infer<typeof FaceSettingsSchema>

export const FACE_DEFAULTS: FaceSettings = FaceSettingsSchema.parse({})

export function resolveFaceSettings(raw: Record<string, unknown>): FaceSettings {
  const pick = <K extends keyof FaceSettings>(key: K): FaceSettings[K] => {
    const field = FaceSettingsSchema.shape[key]
    const parsed = field.safeParse(raw[key])
    return parsed.success ? (parsed.data as FaceSettings[K]) : FACE_DEFAULTS[key]
  }
  return {
    enabled: pick('enabled'),
    similarityThreshold: pick('similarityThreshold'),
    margin: pick('margin'),
    minFaceConfidence: pick('minFaceConfidence'),
    confirmFrames: pick('confirmFrames'),
    bufferRetentionDays: pick('bufferRetentionDays'),
    bufferMaxPerDevice: pick('bufferMaxPerDevice'),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-settings.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/face-settings.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-settings.spec.ts
git commit --no-verify -m "feat(post-analysis): per-device face-recognition settings cascade"
```

---

### Task 2: Pure single-embedding matcher

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/pipeline/face-matcher.ts`
- Test: `packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-matcher.spec.ts`

**Interfaces:**
- Consumes: `cosineSimilarity` from `@camstack/types`.
- Produces: `GallerySample`, `FaceMatch`, `MatchOpts`, `matchEmbedding`.

- [ ] **Step 1: Write the failing test**

Create `face-matcher.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { matchEmbedding, type GallerySample } from '../pipeline/face-matcher.js'

const OPTS = { threshold: 0.45, margin: 0.05 }

function sample(identityId: string, embedding: number[]): GallerySample {
  return { identityId, embedding, modelId: 'arcface-r100' }
}

describe('matchEmbedding', () => {
  it('returns the best identity when above threshold and unambiguous', () => {
    const gallery = [sample('alice', [1, 0, 0, 0]), sample('bob', [0, 1, 0, 0])]
    const m = matchEmbedding({ embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }, gallery, OPTS)
    expect(m).toEqual({ identityId: 'alice', score: 1 })
  })

  it('returns null when the best score is below threshold', () => {
    const gallery = [sample('alice', [1, 0, 0, 0])]
    // orthogonal-ish probe → cosine 0 < 0.45
    const m = matchEmbedding({ embedding: [0, 1, 0, 0], modelId: 'arcface-r100' }, gallery, OPTS)
    expect(m).toBeNull()
  })

  it('returns null when two identities are within the margin (ambiguous)', () => {
    // Two identities that score nearly equally for the probe.
    const gallery = [sample('alice', [1, 0.02, 0, 0]), sample('bob', [1, -0.02, 0, 0])]
    const m = matchEmbedding({ embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }, gallery, OPTS)
    expect(m).toBeNull()
  })

  it('skips samples from a different model id', () => {
    const gallery: GallerySample[] = [{ identityId: 'alice', embedding: [1, 0, 0, 0], modelId: 'old-model' }]
    const m = matchEmbedding({ embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }, gallery, OPTS)
    expect(m).toBeNull()
  })

  it('skips samples whose dimension differs from the probe', () => {
    const gallery = [sample('alice', [1, 0, 0])] // dim 3
    const m = matchEmbedding({ embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }, gallery, OPTS) // dim 4
    expect(m).toBeNull()
  })

  it('takes the max score across multiple samples of the same identity', () => {
    const gallery = [sample('alice', [0, 1, 0, 0]), sample('alice', [1, 0, 0, 0])]
    const m = matchEmbedding({ embedding: [1, 0, 0, 0], modelId: 'arcface-r100' }, gallery, OPTS)
    expect(m).toEqual({ identityId: 'alice', score: 1 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-matcher.spec.ts`
Expected: FAIL — module `../pipeline/face-matcher.js` not found.

- [ ] **Step 3: Implement the single-embedding matcher**

Create `face-matcher.ts`:

```typescript
import { cosineSimilarity } from '@camstack/types'

/** One enrolled face sample in the in-memory gallery. */
export interface GallerySample {
  readonly identityId: string
  readonly embedding: readonly number[]
  /** arcface model id this sample was embedded with — must match the probe. */
  readonly modelId: string
}

/** A confirmed single-frame match: the winning identity + its cosine score. */
export interface FaceMatch {
  readonly identityId: string
  readonly score: number
}

export interface MatchOpts {
  /** Minimum cosine to accept a match. */
  readonly threshold: number
  /** Require best − secondBest(other identity) ≥ margin, else ambiguous → null. */
  readonly margin: number
}

/**
 * Match a probe embedding against the gallery. Only samples with the same
 * `modelId` AND the same dimension are compared (model-version safety). Returns
 * the best identity when its score ≥ threshold and it beats the best OTHER
 * identity by ≥ margin; otherwise null.
 */
export function matchEmbedding(
  probe: { readonly embedding: readonly number[]; readonly modelId: string },
  gallery: readonly GallerySample[],
  opts: MatchOpts,
): FaceMatch | null {
  const probeVec = new Float32Array(probe.embedding)
  // Best score per identity.
  const bestByIdentity = new Map<string, number>()
  for (const s of gallery) {
    if (s.modelId !== probe.modelId) continue
    if (s.embedding.length !== probe.embedding.length) continue
    const score = cosineSimilarity(probeVec, new Float32Array(s.embedding))
    const prev = bestByIdentity.get(s.identityId)
    if (prev === undefined || score > prev) bestByIdentity.set(s.identityId, score)
  }
  if (bestByIdentity.size === 0) return null

  let bestId: string | null = null
  let bestScore = -Infinity
  let secondScore = -Infinity
  for (const [id, score] of bestByIdentity) {
    if (score > bestScore) {
      secondScore = bestScore
      bestScore = score
      bestId = id
    } else if (score > secondScore) {
      secondScore = score
    }
  }
  if (bestId === null || bestScore < opts.threshold) return null
  // Ambiguity guard only applies when there IS a second identity.
  if (secondScore > -Infinity && bestScore - secondScore < opts.margin) return null
  return { identityId: bestId, score: bestScore }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-matcher.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/pipeline/face-matcher.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-matcher.spec.ts
git commit --no-verify -m "feat(post-analysis): pure single-embedding face matcher (cosine + threshold + margin)"
```

---

### Task 3: Per-frame greedy uniqueness + per-track hysteresis

**Files:**
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/pipeline/face-matcher.ts`
- Test: `packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-matcher.spec.ts` (append)

**Interfaces:**
- Consumes: `matchEmbedding`, `GallerySample`, `FaceMatch`, `MatchOpts` (Task 2).
- Produces: `FaceCandidate`, `assignUniquePerFrame`, `TrackAggregate`, `EMPTY_AGGREGATE`, `AggregateOpts`, `updateTrackAggregate`.

**Design decisions (resolving spec §6 ambiguity for the pure layer):**
- **Per-frame uniqueness:** greedy — compute each candidate's best match, sort by score desc, assign each identity to at most one track (the highest-scoring track wins; losers get their next-best match ≥ threshold that is still free, else nothing this frame). Ties (equal score) resolve by input order.
- **Hysteresis:** a track is assigned to an identity once that identity is confirmed `confirmFrames` times (cumulative frames where it was the track's match). Once assigned to A, switching to a different identity B requires B to independently reach `confirmFrames`. Single-frame ambiguity is already filtered by `matchEmbedding`'s margin, so `updateTrackAggregate` works purely on confirmation counts.

- [ ] **Step 1: Write the failing tests**

Append to `face-matcher.spec.ts`:

```typescript
import {
  assignUniquePerFrame,
  updateTrackAggregate,
  EMPTY_AGGREGATE,
  type FaceCandidate,
} from '../pipeline/face-matcher.js'

describe('assignUniquePerFrame', () => {
  it('assigns each identity to at most one track (highest score wins)', () => {
    const gallery = [sample('alice', [1, 0, 0, 0])]
    const candidates: FaceCandidate[] = [
      { trackId: 't1', embedding: [0.9, 0.1, 0, 0], modelId: 'arcface-r100' }, // lower
      { trackId: 't2', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' },     // higher
    ]
    const assigned = assignUniquePerFrame(candidates, gallery, OPTS)
    expect(assigned.get('t2')).toEqual({ identityId: 'alice', score: 1 })
    expect(assigned.has('t1')).toBe(false) // alice already taken by t2
  })

  it('lets a loser take its next-best free identity', () => {
    const gallery = [sample('alice', [1, 0, 0, 0]), sample('bob', [0, 1, 0, 0])]
    const candidates: FaceCandidate[] = [
      { trackId: 't1', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' },      // alice 1.0
      { trackId: 't2', embedding: [0.85, 0.52, 0, 0], modelId: 'arcface-r100' },// alice ~0.85 > bob; alice taken → bob
    ]
    const assigned = assignUniquePerFrame(candidates, gallery, OPTS)
    expect(assigned.get('t1')).toEqual({ identityId: 'alice', score: 1 })
    expect(assigned.get('t2')?.identityId).toBe('bob')
  })
})

describe('updateTrackAggregate', () => {
  const AGG = { confirmFrames: 2 }

  it('assigns after confirmFrames consecutive confirmations', () => {
    let s = EMPTY_AGGREGATE
    let r = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG)
    expect(r.changed).toBe(false)
    expect(r.state.assignedIdentityId).toBeNull()
    r = updateTrackAggregate(r.state, { identityId: 'alice', score: 0.9 }, AGG)
    expect(r.changed).toBe(true)
    expect(r.state.assignedIdentityId).toBe('alice')
  })

  it('a null match does not change state', () => {
    const r = updateTrackAggregate(EMPTY_AGGREGATE, null, AGG)
    expect(r.changed).toBe(false)
    expect(r.state).toEqual(EMPTY_AGGREGATE)
  })

  it('keeps the assignment when the same identity re-matches (no re-fire)', () => {
    let s = EMPTY_AGGREGATE
    s = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG).state
    s = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG).state // assigned
    const r = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG)
    expect(r.changed).toBe(false)
    expect(r.state.assignedIdentityId).toBe('alice')
  })

  it('switches identity only after the challenger reaches confirmFrames', () => {
    let s = EMPTY_AGGREGATE
    s = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG).state
    s = updateTrackAggregate(s, { identityId: 'alice', score: 0.9 }, AGG).state // assigned alice
    let r = updateTrackAggregate(s, { identityId: 'bob', score: 0.9 }, AGG)
    expect(r.state.assignedIdentityId).toBe('alice') // 1 bob confirmation — not yet
    expect(r.changed).toBe(false)
    r = updateTrackAggregate(r.state, { identityId: 'bob', score: 0.9 }, AGG)
    expect(r.state.assignedIdentityId).toBe('bob') // 2 → switch
    expect(r.changed).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-matcher.spec.ts`
Expected: FAIL — `assignUniquePerFrame` / `updateTrackAggregate` / `EMPTY_AGGREGATE` not exported.

- [ ] **Step 3: Implement greedy uniqueness + hysteresis**

Append to `face-matcher.ts`:

```typescript
/** A per-frame face candidate tied to its track. */
export interface FaceCandidate {
  readonly trackId: string
  readonly embedding: readonly number[]
  readonly modelId: string
}

/**
 * Assign at most one identity per track AND at most one track per identity for
 * a single frame. Greedy by score: compute every candidate's full ranked match
 * list, then repeatedly take the globally-highest (track, identity) pair whose
 * track and identity are both still free, until none qualify. A losing track
 * falls back to its next-best free identity ≥ threshold (margin still applies
 * via the per-pair ambiguity check below). Ties resolve by input order.
 */
export function assignUniquePerFrame(
  candidates: readonly FaceCandidate[],
  gallery: readonly GallerySample[],
  opts: MatchOpts,
): Map<string, FaceMatch> {
  // Build ranked candidate→identity scores (threshold + margin applied per pick).
  interface Pair { readonly trackIdx: number; readonly identityId: string; readonly score: number }
  const pairs: Pair[] = []
  candidates.forEach((c, trackIdx) => {
    const probeVec = new Float32Array(c.embedding)
    const bestByIdentity = new Map<string, number>()
    for (const s of gallery) {
      if (s.modelId !== c.modelId) continue
      if (s.embedding.length !== c.embedding.length) continue
      const score = cosineSimilarity(probeVec, new Float32Array(s.embedding))
      const prev = bestByIdentity.get(s.identityId)
      if (prev === undefined || score > prev) bestByIdentity.set(s.identityId, score)
    }
    for (const [identityId, score] of bestByIdentity) {
      if (score >= opts.threshold) pairs.push({ trackIdx, identityId, score })
    }
  })
  // Greedy: stable sort by score desc, input order on ties (forEach above is in order).
  pairs.sort((a, b) => b.score - a.score)
  const takenTracks = new Set<number>()
  const takenIdentities = new Set<string>()
  const result = new Map<string, FaceMatch>()
  for (const p of pairs) {
    if (takenTracks.has(p.trackIdx) || takenIdentities.has(p.identityId)) continue
    takenTracks.add(p.trackIdx)
    takenIdentities.add(p.identityId)
    result.set(candidates[p.trackIdx]!.trackId, { identityId: p.identityId, score: p.score })
  }
  return result
}

/** Per-track accumulation state for hysteresis. Immutable; updated via a copy. */
export interface TrackAggregate {
  readonly assignedIdentityId: string | null
  readonly confirmations: Readonly<Record<string, number>>
}

export const EMPTY_AGGREGATE: TrackAggregate = { assignedIdentityId: null, confirmations: {} }

export interface AggregateOpts {
  readonly confirmFrames: number
}

/**
 * Fold one frame's match into a track's aggregate. A null match leaves state
 * untouched. An identity is assigned once its cumulative confirmation count
 * reaches `confirmFrames`; once assigned, a different identity must independently
 * reach `confirmFrames` to switch. `changed` is true only on a (re)assignment to
 * a NEW identity, so callers fire the label update exactly once per transition.
 */
export function updateTrackAggregate(
  prev: TrackAggregate,
  match: FaceMatch | null,
  opts: AggregateOpts,
): { state: TrackAggregate; changed: boolean } {
  if (match === null) return { state: prev, changed: false }
  const count = (prev.confirmations[match.identityId] ?? 0) + 1
  const confirmations = { ...prev.confirmations, [match.identityId]: count }
  // Not yet enough evidence to (re)assign this identity.
  if (count < opts.confirmFrames) {
    return { state: { ...prev, confirmations }, changed: false }
  }
  // Enough evidence. Assign/switch only if it differs from the current.
  if (prev.assignedIdentityId === match.identityId) {
    return { state: { ...prev, confirmations }, changed: false }
  }
  return { state: { assignedIdentityId: match.identityId, confirmations }, changed: true }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-matcher.spec.ts`
Expected: PASS (all tests — 6 from Task 2 + the new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/pipeline/face-matcher.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-matcher.spec.ts
git commit --no-verify -m "feat(post-analysis): per-frame greedy uniqueness + per-track hysteresis"
```

---

### Task 4: MediaStore `'face'` owner kind + generic `deleteForOwner`

**Files:**
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts`
- Test: `packages/addon-post-analysis/src/pipeline-analytics/__tests__/media-store.spec.ts` (append)

**Interfaces:**
- Consumes: existing `MediaStore` (`put`, `listByOwner`, `deleteForEvents`, `evictBefore`).
- Produces: `OwnerKind = 'event' | 'track' | 'face'`; `put`/`listByOwner` accept `'face'`; `deleteForOwner(ownerKind, ownerIds): Promise<number>`; `deleteForEvents` delegates to it.

- [ ] **Step 1: Write the failing tests**

Append to `media-store.spec.ts` (reuse the file's existing `store` / `storage` / `fake` setup; match its import style):

```typescript
describe('MediaStore — face owner kind', () => {
  it('writes a face crop under the face path and lists it by owner', async () => {
    const key = await store.put({
      deviceId: 7, ownerKind: 'face', ownerId: 'face-1',
      kind: 'crop', timestamp: 2000, data: Buffer.from('jpg'),
    })
    expect(key).toBe('face:face-1:crop:2000')
    expect(storage.files.has('eventMedia:pipeline-analytics/7/face/face-1/crop-2000.jpg')).toBe(true)

    const files = await store.listByOwner('face', 'face-1')
    expect(files.map((f) => f.kind)).toEqual(['crop'])
  })

  it('deleteForOwner removes blobs + index rows for a face owner', async () => {
    await store.put({ deviceId: 7, ownerKind: 'face', ownerId: 'face-1', kind: 'crop', timestamp: 1, data: Buffer.from('a') })
    await store.put({ deviceId: 7, ownerKind: 'face', ownerId: 'face-2', kind: 'crop', timestamp: 1, data: Buffer.from('b') })

    const removed = await store.deleteForOwner('face', ['face-1'])
    expect(removed).toBe(1)
    expect(await store.listByOwner('face', 'face-1')).toHaveLength(0)
    expect(await store.listByOwner('face', 'face-2')).toHaveLength(1) // untouched
  })

  it('deleteForEvents still works (delegates to deleteForOwner)', async () => {
    await store.put({ deviceId: 7, ownerKind: 'event', ownerId: 'evt-1', kind: 'crop', timestamp: 1, data: Buffer.from('a') })
    const removed = await store.deleteForEvents(['evt-1'])
    expect(removed).toBe(1)
    expect(await store.listByOwner('event', 'evt-1')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/media-store.spec.ts`
Expected: FAIL — `put`/`listByOwner` reject `'face'` (TS type error) and `deleteForOwner` does not exist.

- [ ] **Step 3: Extend `media-store.ts`**

Define a shared owner-kind type near the top (replace the inline `'event' | 'track'` union on `MediaPutInput.ownerKind`):

```typescript
export type OwnerKind = 'event' | 'track' | 'face'
```

Change `MediaPutInput.ownerKind` to `readonly ownerKind: OwnerKind`. Change `listByOwner(ownerKind: 'event' | 'track', ownerId: string)` to `listByOwner(ownerKind: OwnerKind, ownerId: string)`.

Replace the existing `deleteForEvents` with a generic owner deleter + a back-compat wrapper:

```typescript
/**
 * Delete all media (blobs + index rows) for the given owners of one kind.
 * Best-effort per row; returns the number of index rows removed.
 */
async deleteForOwner(ownerKind: OwnerKind, ownerIds: readonly string[]): Promise<number> {
  let removed = 0
  for (const ownerId of ownerIds) {
    const rows = await this.store.query.query({
      collection: MEDIA_COLLECTION,
      filter: { where: { ownerKind, ownerId } },
    })
    for (const row of rows) {
      const path = String((row.data as Record<string, unknown>)['path'] ?? '')
      try {
        if (path) await this.storage.delete({ location: 'eventMedia', relativePath: path })
      } catch { /* best-effort */ }
      try {
        await this.store.delete.mutate({ collection: MEDIA_COLLECTION, key: row.id })
        removed++
      } catch (err) {
        this.logger.debug('media delete-for-owner failed', { meta: { key: row.id, error: String(err) } })
      }
    }
  }
  return removed
}

/** Back-compat: existing retention path deletes media for evicted events. */
async deleteForEvents(eventIds: readonly string[]): Promise<number> {
  return this.deleteForOwner('event', eventIds)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/media-store.spec.ts`
Expected: PASS (existing media-store tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/media-store.spec.ts
git commit --no-verify -m "feat(post-analysis): MediaStore 'face' owner kind + generic deleteForOwner"
```

---

### Task 5: Forward-only label propagation (`EventStore.setLabelForTrack` + `TrackStore.setLabel`)

**Files:**
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts`
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts`
- Test: `…/__tests__/event-store.spec.ts` (append), `…/__tests__/track-store.spec.ts` (append)

**Interfaces:**
- Consumes: existing `EventStore` (`insertObject`, `queryObject`, `OBJECT_EVENTS_COLLECTION`, the `settingsStore` `update` mutation), `TrackStore` (`active` map, `persistCompleted`/`set` mutation, `TRACKS_COLLECTION`).
- Produces: `EventStore.setLabelForTrack(trackId: string, label: string): Promise<number>`; `TrackStore.setLabel(trackId: string, label: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `event-store.spec.ts` (reuse its `object(...)` helper + `store`/`fake` setup):

```typescript
describe('setLabelForTrack (forward-only)', () => {
  beforeEach(async () => { await EventStore.declare(fake.client) })

  it("updates the label on every object event of a track, leaving others", async () => {
    await store.insertObject(object('o1', 4, 1000)) // trackId from helper — see below
    await store.insertObject(object('o2', 4, 2000))
    await store.insertObject(object('o3', 4, 3000))

    // o1/o2 belong to track 'tA', o3 to 'tB' — set via the helper's trackId arg.
    const updated = await store.setLabelForTrack('tA', 'Alice')
    expect(updated).toBe(2)

    const rows = await store.queryObject({ deviceId: 4 })
    const byId = new Map(rows.map((r) => [r.id, r.label]))
    expect(byId.get('o1')).toBe('Alice')
    expect(byId.get('o2')).toBe('Alice')
    expect(byId.get('o3')).not.toBe('Alice')
  })
})
```

> NOTE for the implementer: the existing `object(id, deviceId, ts)` helper hard-codes a `trackId`. Extend the helper (or add a local one) so `o1`/`o2` carry `trackId: 'tA'` and `o3` carries `trackId: 'tB'`. Keep the change minimal and within the test file.

Append to `track-store.spec.ts` (reuse its setup):

```typescript
describe('setLabel', () => {
  it('sets the label on an active track and persists it', async () => {
    store.upsert({
      trackId: 'tA', deviceId: 4, className: 'person', timestamp: 1000,
      position: { x: 1, y: 1, t: 1000 } as never, zones: [], state: 'active' as never,
    })
    await store.setLabel('tA', 'Alice')
    const rows = await store.queryHistorical({ deviceId: 4 })
    const tA = rows.find((t) => t.trackId === 'tA')
    expect(tA?.label).toBe('Alice')
  })
})
```

> NOTE: match the real `upsert` param types from `track-store.ts` — the `as never` casts above are placeholders; use the actual `TrackPosition` / `TrackState` values the file already uses in its other tests.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/event-store.spec.ts packages/addon-post-analysis/src/pipeline-analytics/__tests__/track-store.spec.ts`
Expected: FAIL — `setLabelForTrack` / `setLabel` not defined.

- [ ] **Step 3: Implement `EventStore.setLabelForTrack`**

Add to `EventStore` (uses the `update` mutation the fake store already supports; queries by the existing `idx_object_track` index via a `where: { trackId }` filter):

```typescript
/**
 * Forward-only: set `label` on every already-emitted object event of a track.
 * Returns the number of events updated. Best-effort per row. Used when face
 * recognition assigns a name to a track after its events were emitted.
 */
async setLabelForTrack(trackId: string, label: string): Promise<number> {
  const rows = await this.store.query.query({
    collection: OBJECT_EVENTS_COLLECTION,
    filter: { where: { trackId } },
  })
  let updated = 0
  for (const row of rows) {
    try {
      await this.store.update.mutate({
        collection: OBJECT_EVENTS_COLLECTION,
        id: row.id,
        data: { label },
      })
      updated++
    } catch (err) {
      this.logger.warn('setLabelForTrack update failed', { meta: { trackId, eventId: row.id, error: String(err) } })
    }
  }
  return updated
}
```

> If the real `settingsStore` client's `update` mutation differs in shape from the fake (`{ collection, id, data }`), match the REAL client signature (check `SettingsStoreClient`) and adjust the fake/test if needed — the production shape governs.

- [ ] **Step 4: Implement `TrackStore.setLabel`**

Add to `TrackStore`:

```typescript
/**
 * Set a track's label. Updates the in-memory active state (so the label is
 * carried into the eventual persist) AND, if the track was already persisted,
 * patches the stored row. Forward-only — never rewrites history beyond the label.
 */
async setLabel(trackId: string, label: string): Promise<void> {
  const active = this.active.get(trackId)
  if (active) active.label = label
  try {
    await this.store.update.mutate({
      collection: TRACKS_COLLECTION,
      id: trackId,
      data: { label },
    })
  } catch (err) {
    this.logger.warn('setLabel persist failed', { meta: { trackId, error: String(err) } })
  }
}
```

> Verify `this.active`'s `MutableTrackState.label` is assignable (it is `string | undefined`). If `TrackStore` has no `logger`, use the file's existing error-logging idiom or drop the catch-log to match the file's style.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics/__tests__/event-store.spec.ts packages/addon-post-analysis/src/pipeline-analytics/__tests__/track-store.spec.ts`
Expected: PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts \
        packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/event-store.spec.ts \
        packages/addon-post-analysis/src/pipeline-analytics/__tests__/track-store.spec.ts
git commit --no-verify -m "feat(post-analysis): forward-only label propagation (setLabelForTrack + track setLabel)"
```

---

### Task 6: Verify the package

**Files:** none (verify only).

- [ ] **Step 1: Typecheck the package**

Run: `cd packages/addon-post-analysis && npx tsc --noEmit`
Expected: clean. Return to repo root.

- [ ] **Step 2: Run the full pipeline-analytics suite (no regressions)**

Run: `npx vitest run --exclude '**/.claude/**' packages/addon-post-analysis/src/pipeline-analytics`
Expected: all tests pass (existing + the new face-settings/face-matcher/media/event/track tests).

> No deploy in 1a — these foundations are dormant until the `FaceRecognizer` wires them in (sub-plan 1c). Deploy happens at the end of 1c.

---

## Self-Review

**Spec coverage (this sub-plan's slice of spec §1/§4/§6/§9/§11):**
- "Detection intelligence" face config + per-device cascade (`resolveDeviceFaceSettings` foundation) → Task 1 (`resolveFaceSettings` + schema; the per-device wrapper that reads `readDeviceStore` lives in 1c where it's consumed). ✅
- Pure matcher: cosine + threshold + margin + per-frame greedy uniqueness + per-track hysteresis (§6, §11 "Pure (face-matcher.ts)") → Tasks 2–3. ✅
- MediaStore `ownerKind` extend with `'face'` (§5) → Task 4. ✅
- `EventStore.setLabelForTrack` forward-only + track label (§4.5) → Task 5. ✅
- Retention (`bufferRetentionDays`/`bufferMaxPerDevice`) and the stores (`IdentityStore`/`FaceStore`) and the `FaceRecognizer` are 1b/1c — explicitly out of 1a.

**Placeholder scan:** every code step has complete code. Task 5's two test snippets carry explicit `NOTE` directives to match the real `object(...)`/`upsert(...)` helper shapes (the spec's own test fixtures vary per file) — these are instructions to adapt to verified local helpers, not vague TODOs; the implementer must read the existing spec helpers. Flagged for the reviewer.

**Type consistency:** `GallerySample`/`FaceMatch`/`MatchOpts`/`FaceCandidate`/`TrackAggregate`/`AggregateOpts` are defined in Task 2/3 and reused consistently. `OwnerKind` is introduced in Task 4 and used by `put`/`listByOwner`/`deleteForOwner`. `setLabelForTrack`/`setLabel` signatures match the produced-interfaces block.

**Open items deliberately deferred to 1c (named, not gaps):** the per-device `resolveDeviceFaceSettings(deviceId)` wrapper (reads `ctx.settings.readDeviceStore` + 5s cache, mirrors `resolveDeviceTrackingSettings`) is wired where it's consumed; `assignUniquePerFrame`'s margin handling is intentionally simplified to a per-pair threshold (single-frame ambiguity already filtered by `matchEmbedding`); confirm-the-real-`update`-mutation-shape notes in Task 5.
