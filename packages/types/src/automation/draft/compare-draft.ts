/**
 * `compareDraft` — how close is what the model wrote to what was meant, 0..1.
 *
 * Deterministic and structural, because "the same automation" has many
 * spellings: both sides are parsed (so schema defaults and `{ value, unit }` quantities all land on one shape), then
 * compared as trees:
 *
 *  - names, ids and display-only keys are ignored;
 *  - the children of `all`/`any`, device id lists, zones, days, profiles and
 *    points are SETS — order does not matter; steps stay ordered;
 *  - strings compare case-insensitively, numbers to three decimals;
 *  - a mismatch on what the entity does or who it acts on (device, action, cap,
 *    field, kind, threshold, level, a missing step) is a MISS, and any miss
 *    keeps the score under 0.9 whatever the size of the entity — one wrong
 *    device in a ten-leaf recipe cannot hide behind the nine right ones.
 *    Tuning knobs (`forMs`, `minScore`, `runMode`…) only cost their share.
 */
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import { CompositionSchema } from '../../composition/composition.js'
import { ActionInputSchema } from '../action.js'
import { capUnitResolver } from '../normalize-units.js'
import { prepareRecipeUnits } from '../prepare-units.js'
import { CurrentAutomationRecipeSchema } from '../recipe.js'
import { SchedulerInputSchema } from '../scheduler.js'
import { isRecord } from './draft-json.js'
import type { DraftKind } from './draft-types.js'

const IGNORED_KEYS: ReadonlySet<string> = new Set([
  'name',
  'id',
  'label',
  'argUnits',
  'unit',
  'keepTraces',
  'enabled',
])
const SET_KEYS: ReadonlySet<string> = new Set([
  'children',
  'ids',
  'deviceIds',
  'zones',
  'subjects',
  'days',
  'reads',
  'features',
  'profiles',
  'points',
])
/** Tuning knobs: a miss here changes a little, not WHAT the entity does or WHO it acts on. */
const MINOR_KEYS: ReadonlySet<string> = new Set([
  'forMs',
  'debounceMs',
  'edge',
  'minScore',
  'runMode',
  'priority',
  'maxLateMs',
  'role',
  'publish',
  'empty',
  'mode',
])
/** Any miss on what/who keeps the score under 0.9 whatever the size of the entity. */
const MISS_FACTOR = 0.9
const DECIMALS = 1000

function normalise(kind: DraftKind, json: unknown): unknown {
  switch (kind) {
    case 'automation': {
      const parsed = CurrentAutomationRecipeSchema.safeParse(json)
      if (!parsed.success) return json
      const prepared = prepareRecipeUnits(parsed.data, capUnitResolver(ALL_CAPABILITY_DEFINITIONS))
      return prepared.ok ? prepared.recipe : parsed.data
    }
    case 'action': {
      const parsed = ActionInputSchema.safeParse(json)
      return parsed.success ? parsed.data : json
    }
    case 'scheduler': {
      const parsed = SchedulerInputSchema.safeParse(json)
      return parsed.success ? parsed.data : json
    }
    case 'composition': {
      const parsed = CompositionSchema.safeParse(json)
      return parsed.success ? parsed.data : json
    }
  }
}

/** A stable string for ordering a set's elements. */
function keyOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(keyOf).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((k) => !IGNORED_KEYS.has(k))
      .toSorted()
    return `{${keys.map((k) => `${k}:${keyOf(value[k])}`).join(',')}}`
  }
  if (typeof value === 'string') return JSON.stringify(value.trim().toLowerCase())
  if (typeof value === 'number') return String(Math.round(value * DECIMALS) / DECIMALS)
  return JSON.stringify(value) ?? 'undefined'
}

interface Scored {
  /** 0..1 similarity of the two sides. */
  readonly score: number
  /** Misses on what the entity does or who it acts on (tuning knobs excluded). */
  readonly misses: number
}

const SAME: Scored = { score: 1, misses: 0 }

function missOf(key: string): number {
  return MINOR_KEYS.has(key) ? 0 : 1
}

function orderedScore(a: readonly unknown[], b: readonly unknown[], key: string): Scored {
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return SAME
  let total = 0
  let misses = Math.abs(a.length - b.length) * missOf(key)
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const s = score(a[i], b[i], key)
    total += s.score
    misses += s.misses
  }
  return { score: total / longest, misses }
}

function setScore(a: readonly unknown[], b: readonly unknown[], key: string): Scored {
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return SAME
  const free = [...b]
  let total = 0
  let misses = 0
  for (const left of a) {
    let best = -1
    let bestScored: Scored = { score: 0, misses: missOf(key) }
    free.forEach((right, i) => {
      const s = score(left, right, key)
      if (s.score > bestScored.score) {
        bestScored = s
        best = i
      }
    })
    if (best >= 0) free.splice(best, 1)
    total += bestScored.score
    misses += bestScored.misses
  }
  misses += free.length * missOf(key)
  return { score: total / longest, misses }
}

function objectScore(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): Scored {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => !IGNORED_KEYS.has(k) && !(a[k] === undefined && b[k] === undefined),
  )
  if (keys.length === 0) return SAME
  let total = 0
  let misses = 0
  for (const k of keys) {
    const s = score(a[k], b[k], k)
    total += s.score
    misses += s.misses
  }
  return { score: total / keys.length, misses }
}

function score(a: unknown, b: unknown, key: string): Scored {
  if (a === undefined || b === undefined) {
    return a === b ? SAME : { score: 0, misses: missOf(key) }
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return SET_KEYS.has(key) ? setScore(a, b, key) : orderedScore(a, b, key)
  }
  if (isRecord(a) && isRecord(b)) return objectScore(a, b)
  const same = keyOf(a) === keyOf(b)
  return same ? SAME : { score: 0, misses: missOf(key) }
}

/** Semantic similarity of two drafts of `kind`, 0..1 (1 = the same entity). */
export function compareDraft(kind: DraftKind, actual: unknown, expected: unknown): number {
  const { score: mean, misses } = score(normalise(kind, actual), normalise(kind, expected), '')
  const final = misses === 0 ? mean : mean * MISS_FACTOR
  return Math.max(0, Math.min(1, Math.round(final * DECIMALS) / DECIMALS))
}
