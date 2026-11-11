/**
 * A read-only walk of a HomeCom gateway's pointt resource tree, for diagnosing what a
 * gateway actually serves. A container answers `{ type: 'refEnum', references: [{ id, uri }] }`;
 * a leaf answers `{ id, type, value, unitOfMeasure, writeable, allowedValues, ... }`.
 *
 * The walk is breadth-first, sequential and paced (`delayMs` between two calls). The first
 * 429 stops it: the gateway is asking us to back off, and a diagnostic must not cost the
 * integration its polling budget. It only ever reads (`HomeComResourceRead` is a GET).
 */

import { z } from 'zod'

export const EXPLORER_DEFAULT_MAX_NODES = 400
export const EXPLORER_MAX_NODES_CAP = 1500
export const EXPLORER_MIN_DELAY_MS = 150
const VALUE_MAX_CHARS = 200

/** Roots walked when `/` does not list its children. */
export const EXPLORER_SEED_ROOTS: readonly string[] = [
  '/system',
  '/heatSources',
  '/heatingCircuits',
  '/dhwCircuits',
  '/gateway',
  '/notifications',
  '/recordings',
  '/devices',
  '/solarCircuits',
  '/ventilation',
]

export const EXPLORER_DEFAULT_DEADLINE_MS = 45_000
/** Under the 60 s UDS request timeout a forked addon's action answers within. */
export const EXPLORER_MAX_DEADLINE_MS = 50_000
const DROPPED_SAMPLE_MAX = 20
const UNVISITED_SAMPLE_MAX = 100

const PATH_SHAPE = /^\/(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?$/

/**
 * A resource path this walker will request: absolute, plain segments, and no `.` or `..`
 * segment — URL resolution would otherwise lift the request out of the gateway's tree.
 */
export function isResourcePath(path: string): boolean {
  if (!PATH_SHAPE.test(path)) return false
  return path
    .split('/')
    .slice(1)
    .every((segment) => segment !== '.' && segment !== '..')
}

export interface HomeComResourceAnswer {
  readonly status: number
  readonly body: unknown
}

/** One authenticated GET of a pointt resource path. */
export type HomeComResourceRead = (path: string) => Promise<HomeComResourceAnswer>

export const explorerOutcomeSchema = z.enum([
  'ok',
  'forbidden',
  'not-found',
  'rate-limited',
  'error',
])
export type ExplorerOutcome = z.infer<typeof explorerOutcomeSchema>

export const exploredResourceSchema = z.object({
  path: z.string(),
  httpStatus: z.number(),
  outcome: explorerOutcomeSchema,
  type: z.string().optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  unit: z.string().optional(),
  writeable: z.boolean().optional(),
  recordable: z.boolean().optional(),
  allowedValues: z.array(z.string()).optional(),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  childCount: z.number().optional(),
  /** References of this container that were not a walkable path. */
  droppedReferences: z.number().optional(),
  error: z.string().optional(),
})
export type ExploredResource = z.infer<typeof exploredResourceSchema>

export const explorerSummarySchema = z.object({
  ok: z.number(),
  forbidden: z.number(),
  'not-found': z.number(),
  'rate-limited': z.number(),
  error: z.number(),
})
export type ExplorerSummary = z.infer<typeof explorerSummarySchema>

export const explorerStopReasonSchema = z.enum([
  'complete',
  'max-nodes',
  'rate-limited',
  'deadline',
])
export type ExplorerStopReason = z.infer<typeof explorerStopReasonSchema>

export interface ExplorerResult {
  readonly root: string
  readonly resources: ExploredResource[]
  readonly summary: ExplorerSummary
  readonly stoppedBy: ExplorerStopReason
  /** Paths found but not visited because the walk stopped first. */
  readonly unvisited: number
  /** The first of them, in walk order: call again with one as `root` to resume. */
  readonly unvisitedPaths: string[]
  /** References the gateway returned that were not a walkable path. */
  readonly droppedReferences: number
  /** The first of them, as `<container> -> <reference>`. */
  readonly droppedSamples: string[]
}

export interface ExplorerInput {
  readonly read: HomeComResourceRead
  readonly root?: string
  readonly maxNodes?: number
  readonly delayMs?: number
  readonly deadlineMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function truncate(value: string): string {
  return value.length > VALUE_MAX_CHARS ? `${value.slice(0, VALUE_MAX_CHARS - 1)}…` : value
}

function shownValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return truncate(value)
  return truncate(JSON.stringify(value))
}

function outcomeOf(status: number): ExplorerOutcome {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate-limited'
  return 'error'
}

/** What a reference names: its `id`, else the part of its `uri` after `/resource`. */
function referenceText(ref: unknown): string | null {
  if (!isRecord(ref)) return null
  const id = text(ref['id'])
  if (id !== undefined && id.startsWith('/')) return id
  const uri = text(ref['uri'])
  if (uri === undefined) return id ?? null
  const at = uri.indexOf('/resource/')
  if (at < 0) return uri
  return uri.slice(at + '/resource'.length)
}

/** The walkable resource path a reference names, or null. */
export function referencePath(ref: unknown): string | null {
  const path = referenceText(ref)
  return path !== null && isResourcePath(path) ? path : null
}

interface ContainerReferences {
  readonly total: number
  readonly paths: readonly string[]
  readonly dropped: readonly string[]
}

function referencesOf(body: unknown): ContainerReferences | null {
  if (!isRecord(body)) return null
  const refs = body['references']
  if (!Array.isArray(refs)) return null
  const paths: string[] = []
  const dropped: string[] = []
  for (const ref of refs) {
    const path = referencePath(ref)
    if (path !== null) paths.push(path)
    else dropped.push(truncate(referenceText(ref) ?? JSON.stringify(ref) ?? 'undefined'))
  }
  return { total: refs.length, paths, dropped }
}

function describeLeaf(path: string, status: number, body: unknown): ExploredResource {
  if (!isRecord(body)) return { path, httpStatus: status, outcome: 'ok' }
  const allowed = body['allowedValues']
  const allowedValues = Array.isArray(allowed) ? allowed.map((v) => truncate(String(v))) : undefined
  const type = text(body['type'])
  const unit = text(body['unitOfMeasure'])
  const minValue = finite(body['minValue'])
  const maxValue = finite(body['maxValue'])
  const writeable = body['writeable']
  const recordable = body['recordable']
  return {
    path,
    httpStatus: status,
    outcome: 'ok',
    ...(type !== undefined ? { type } : {}),
    ...('value' in body ? { value: shownValue(body['value']) } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(typeof writeable === 'number' || typeof writeable === 'boolean'
      ? { writeable: Boolean(writeable) }
      : {}),
    ...(typeof recordable === 'number' || typeof recordable === 'boolean'
      ? { recordable: Boolean(recordable) }
      : {}),
    ...(allowedValues !== undefined ? { allowedValues } : {}),
    ...(minValue !== undefined ? { minValue } : {}),
    ...(maxValue !== undefined ? { maxValue } : {}),
  }
}

function emptySummary(): ExplorerSummary {
  return { ok: 0, forbidden: 0, 'not-found': 0, 'rate-limited': 0, error: 0 }
}

function clampDeadline(requested: number | undefined): number {
  const ms = Math.floor(requested ?? EXPLORER_DEFAULT_DEADLINE_MS)
  return Math.min(Math.max(ms, 1), EXPLORER_MAX_DEADLINE_MS)
}

function clampNodes(requested: number | undefined): number {
  const n = Math.floor(requested ?? EXPLORER_DEFAULT_MAX_NODES)
  return Math.min(Math.max(n, 1), EXPLORER_MAX_NODES_CAP)
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export async function exploreHomeComResources(input: ExplorerInput): Promise<ExplorerResult> {
  const root = input.root ?? '/'
  if (!isResourcePath(root)) throw new Error(`Not a resource path: ${root}`)
  const maxNodes = clampNodes(input.maxNodes)
  const delayMs = Math.max(input.delayMs ?? EXPLORER_MIN_DELAY_MS, EXPLORER_MIN_DELAY_MS)
  const sleep = input.sleep ?? defaultSleep
  const now = input.now ?? Date.now
  const deadlineAt = now() + clampDeadline(input.deadlineMs)

  const queue: string[] = [root]
  const queued = new Set<string>([root])
  const resources: ExploredResource[] = []
  const summary = emptySummary()
  let calls = 0
  let stoppedBy: ExplorerStopReason = 'complete'
  let droppedReferences = 0
  const droppedSamples: string[] = []

  const enqueue = (paths: readonly string[]): void => {
    for (const path of paths) {
      if (queued.has(path)) continue
      queued.add(path)
      queue.push(path)
    }
  }

  while (queue.length > 0) {
    if (calls >= maxNodes) {
      stoppedBy = 'max-nodes'
      break
    }
    // The pause before the next call must still end inside the deadline.
    if (now() + (calls > 0 ? delayMs : 0) >= deadlineAt) {
      stoppedBy = 'deadline'
      break
    }
    const path = queue.shift()
    if (path === undefined) break
    if (calls > 0) await sleep(delayMs)
    calls += 1
    let answer: HomeComResourceAnswer
    try {
      answer = await input.read(path)
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err)
      resources.push({ path, httpStatus: 0, outcome: 'error', error })
      summary.error += 1
      continue
    }
    const outcome = outcomeOf(answer.status)
    summary[outcome] += 1
    if (outcome === 'rate-limited') {
      resources.push({ path, httpStatus: answer.status, outcome })
      stoppedBy = 'rate-limited'
      break
    }
    if (outcome !== 'ok') {
      resources.push({ path, httpStatus: answer.status, outcome })
      // `/` that does not list its children: walk the known roots instead.
      if (path === '/' && root === '/') enqueue(EXPLORER_SEED_ROOTS)
      continue
    }
    const children = referencesOf(answer.body)
    if (children !== null) {
      const type = isRecord(answer.body) ? text(answer.body['type']) : undefined
      resources.push({
        path,
        httpStatus: answer.status,
        outcome,
        type: type ?? 'refEnum',
        childCount: children.total,
        ...(children.dropped.length > 0 ? { droppedReferences: children.dropped.length } : {}),
      })
      droppedReferences += children.dropped.length
      for (const ref of children.dropped) {
        if (droppedSamples.length < DROPPED_SAMPLE_MAX) droppedSamples.push(`${path} -> ${ref}`)
      }
      enqueue(children.paths)
      continue
    }
    resources.push(describeLeaf(path, answer.status, answer.body))
    if (path === '/' && root === '/') enqueue(EXPLORER_SEED_ROOTS)
  }

  return {
    root,
    resources,
    summary,
    stoppedBy,
    unvisited: queue.length,
    unvisitedPaths: queue.slice(0, UNVISITED_SAMPLE_MAX),
    droppedReferences,
    droppedSamples,
  }
}
