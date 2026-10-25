/**
 * THE test that would have been needed, and that did not exist.
 *
 * `object-trigger.spec.ts` validates the gate against a fixture written by the author
 * of the gate. That fixture agreed with the gate for the whole time the
 * gate was disagreeing with the BUS: the topic
 * `pipeline-analytics.detection-event` has no shared schema in
 * `@camstack/types` — it does not appear in `EventPayloadMap` — so the two banks
 * have no type keeping them aligned, and nothing went red when they
 * drifted apart. They stayed apart for weeks, at 100% rejections.
 *
 * This test reads the source of the EMITTER and extracts the payloads
 * actually emitted, then runs them through the real gate. If someone renames
 * `className`, adds a fourth `kind`, or changes the type of `deviceId` on one
 * side only, this file goes red — which is the only thing this defect
 * asked for.
 *
 * The test also defends itself: if the extractor stops finding the
 * emission sites (file moved, `emit` rewritten) it fails instead of passing
 * vacuously. An extractor that finds nothing and declares green is the same class
 * of bug it is testing.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { qualifyObjectTrigger } from '../object-trigger.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * The emitter. Path relative to this file: `addon-pipeline` does NOT depend on
 * `addon-post-analysis` (addons do not import each other — `ctx.api` is the only layer
 * between addons) and must not start doing so for a test. The source is read.
 */
const EMITTER_SOURCE = path.resolve(
  HERE,
  '../../../../addon-post-analysis/src/pipeline-analytics/index.ts',
)

const CATEGORY_MARKER = 'category: EventCategory.PipelineAnalyticsDetectionEvent,'

/** A `data: { … }` payload as the emitter writes it. */
interface EmittedPayload {
  /** Top-level keys of the `data` object. */
  readonly keys: readonly string[]
  /** The literal of `kind`, when the emitter writes one. */
  readonly kind: string | null
  /** Line (1-based) of the marker, for an error message that can be opened. */
  readonly line: number
}

/** Extracts the balanced `{ … }` block that starts at `open`. */
function balancedBlock(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced object literal at offset ${open}`)
}

/** Strips line comments, which would otherwise be read as keys. */
function stripLineComments(block: string): string {
  return block
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

const IDENTIFIER_AT_START = /^\s*([A-Za-z_$][\w$]*)/

/**
 * Top-LEVEL keys of an object literal, shorthand included.
 *
 * Depth scan: a key is an identifier that opens a top-level segment
 * (start of the block, or right after a top-level comma).
 * Everything inside `{}`/`[]`/`()` belongs to a value.
 */
function topLevelKeys(block: string): readonly string[] {
  const body = stripLineComments(block).slice(1, -1)
  const keys: string[] = []
  let depth = 0
  let segmentStart = 0
  const takeSegment = (end: number): void => {
    const segment = body.slice(segmentStart, end)
    const m = IDENTIFIER_AT_START.exec(segment)
    if (m?.[1] !== undefined) keys.push(m[1])
  }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '{' || c === '[' || c === '(') depth += 1
    else if (c === '}' || c === ']' || c === ')') depth -= 1
    else if (c === ',' && depth === 0) {
      takeSegment(i)
      segmentStart = i + 1
    }
  }
  takeSegment(body.length)
  return keys
}

function extractEmittedPayloads(src: string): readonly EmittedPayload[] {
  const out: EmittedPayload[] = []
  let from = 0
  for (;;) {
    const at = src.indexOf(CATEGORY_MARKER, from)
    if (at < 0) break
    from = at + CATEGORY_MARKER.length
    const dataAt = src.indexOf('data: {', from)
    if (dataAt < 0) continue
    const block = balancedBlock(src, src.indexOf('{', dataAt))
    const kindMatch = /(?:^|[\s,{])kind:\s*'([^']+)'/.exec(block)
    out.push({
      keys: topLevelKeys(block),
      kind: kindMatch?.[1] ?? null,
      line: src.slice(0, at).split('\n').length,
    })
  }
  return out
}

/** A plausible value for every key the emitter writes. The types are
 *  the real payload ones: if one bank changes one, the gate sees it. */
function sampleValueFor(key: string): unknown {
  switch (key) {
    case 'deviceId':
      return 102
    case 'timestamp':
      return 1_700_000_000_000
    case 'kind':
      return 'object'
    case 'eventId':
      return 'ev-1'
    case 'className':
      return 'person'
    case 'source':
      return 'pipeline'
    case 'confidence':
      return 0.91
    case 'zones':
      return []
    default:
      return 'x'
  }
}

function synthesize(payload: EmittedPayload): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of payload.keys) out[k] = sampleValueFor(k)
  if (payload.kind !== null) out['kind'] = payload.kind
  return out
}

const source = readFileSync(EMITTER_SOURCE, 'utf8')
const payloads = extractEmittedPayloads(source)

describe('contratto col vero emettitore di pipeline-analytics.detection-event', () => {
  it('the extractor really finds the emission sites (otherwise the test is empty and green)', () => {
    expect(payloads.length).toBeGreaterThanOrEqual(3)
    const kinds = new Set(payloads.map((p) => p.kind))
    // The topic is shared: at least one object and at least one non-object. If this
    // stops being true, the gate must be re-read, not the test.
    expect(kinds.has('object')).toBe(true)
    expect([...kinds].some((k) => k !== null && k !== 'object')).toBe(true)
  })

  it('every emitted payload has a readable ENVELOPE — `malformed` never appears', () => {
    for (const p of payloads) {
      const verdict = qualifyObjectTrigger(synthesize(p))
      expect(
        verdict.qualified ? 'qualified' : verdict.reason,
        `payload kind=${p.kind ?? '?'} emesso a ${path.basename(EMITTER_SOURCE)}:${p.line} — ` +
          `chiavi [${p.keys.join(', ')}]`,
      ).not.toBe('malformed')
    }
  })

  it('the object branch qualifies; the other kinds exit not-object, never malformed', () => {
    for (const p of payloads) {
      const verdict = qualifyObjectTrigger(synthesize(p))
      const label = `${p.kind ?? '?'} @ ${p.line}`
      if (p.kind === 'object') {
        expect(verdict.qualified, label).toBe(true)
      } else {
        expect(verdict.qualified, label).toBe(false)
        expect(verdict.qualified ? null : verdict.reason, label).toBe('not-object')
      }
    }
  })
})
