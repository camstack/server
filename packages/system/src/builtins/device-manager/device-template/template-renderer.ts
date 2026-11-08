/**
 * The hub's device value-template renderer (D1021).
 *
 * Owner: device-manager. It owns the device rows and the aliases a template
 * names, and this directory is the only one allowed to import nunjucks
 * (guard `check-device-template-grammar`).
 *
 * A render is: vet the template (`analyzeTemplate`), resolve every reference
 * against the devices' current slices, build a context of only the values the
 * template names, and hand it to a worker thread under a wall-time budget. A
 * worker that overruns is terminated and respawned on the next render. What a
 * reference cannot resolve renders `—` and goes into the trace; an ambiguous
 * `alias.field` refuses the whole render, naming the capabilities.
 */
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  DEVICE_TEMPLATE_BUDGET_MS,
  DEVICE_TEMPLATE_FILTERS,
  DEVICE_TEMPLATE_MAX_LENGTH,
  DEVICE_TEMPLATE_MAX_OUTPUT,
  DEVICE_TEMPLATE_UNAVAILABLE,
  type DeviceTemplateRef,
  type DeviceTemplateRefusal,
  type DeviceTemplateRender,
  type DeviceTemplateTraceEntry,
  type DeviceTemplateView,
  resolveTemplateRef,
} from '@camstack/types'
import { analyzeTemplate, type TemplateAnalysis, type UnitSite } from './template-grammar.js'
import {
  isRenderResponse,
  type RenderRequest,
  type RenderResponse,
  type TemplateWorkerData,
} from './template-protocol.js'

/** How the renderer finds a device by alias. The hub adapter answers it from the device rows and the state mirror. */
export interface DeviceTemplateResolver {
  viewOf(alias: string): DeviceTemplateView | undefined
}

/** `dist/device-template-worker.js` at the package root, found through its own `package.json`. */
export function defaultTemplateWorkerPath(): string {
  const require_ = createRequire(import.meta.url)
  const packageRoot = path.dirname(require_.resolve('@camstack/server/system/package.json'))
  return path.join(packageRoot, 'dist', 'device-template-worker.js')
}

export interface DeviceTemplateRendererOptions {
  readonly workerPath?: string
  /** Specs run the TypeScript source: `['--import', 'tsx']`. */
  readonly workerExecArgv?: readonly string[]
  readonly budgetMs?: number
  readonly now?: () => number
  /** How long a fresh worker may take to announce `ready` (default 10 s). */
  readonly spawnTimeoutMs?: number
  /** Renders allowed to wait behind the running one before `busy` (default 16). */
  readonly maxQueue?: number
  /** Consecutive timeouts of one template before it is refused without running (default 3). */
  readonly breakerThreshold?: number
  /** How long a tripped template stays refused (default 60 s). */
  readonly breakerWindowMs?: number
}

/** Room for the hidden source-unit arguments the renderer adds to `unit()` calls. */
const REWRITE_ALLOWANCE = 2048
/**
 * The cold start of the worker thread (loading nunjucks) is NOT part of a
 * render's budget: the budget timer starts only once the worker has announced
 * `ready`. A thread that never does is killed after this long, and the next
 * render respawns it.
 */
const SPAWN_TIMEOUT_MS = 10_000
const DEFAULT_MAX_QUEUE = 16
const DEFAULT_BREAKER_THRESHOLD = 3
const DEFAULT_BREAKER_WINDOW_MS = 60_000
const BREAKER_MAX_TEMPLATES = 256

interface BreakerState {
  timeouts: number
  openUntil: number
}

interface PendingRender {
  readonly worker: Worker
  readonly resolve: (response: RenderResponse) => void
}

function isReadyMessage(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'ready') === true
}

/** Copy a value as plain data only: primitives, arrays and plain objects. Anything else (functions, class instances) is dropped. */
function plainCopy(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (depth > 8) return undefined
  if (Array.isArray(value)) return value.map((item) => plainCopy(item, depth + 1))
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value)) out[key] = plainCopy(Reflect.get(value, key), depth + 1)
    return out
  }
  return undefined
}

type Container = Record<string, unknown>

/** The context under construction: containers this builder made, so a longer path never writes into a caller's value. */
class ContextTree {
  readonly root: Container = Object.create(null)
  private readonly ours = new WeakSet<object>()

  constructor() {
    this.ours.add(this.root)
  }

  private isOurs(value: unknown): value is Container {
    return typeof value === 'object' && value !== null && this.ours.has(value)
  }

  place(alias: string, keys: readonly (string | number)[], value: unknown): void {
    let cursor = this.root
    let key: string = alias
    for (const next of keys) {
      const existing = cursor[key]
      if (existing !== undefined && !this.isOurs(existing)) return // a shorter path already carries this subtree
      let child: Container
      if (this.isOurs(existing)) {
        child = existing
      } else {
        child = Object.create(null)
        this.ours.add(child)
        cursor[key] = child
      }
      cursor = child
      key = String(next)
    }
    cursor[key] = value
  }
}

function offsetOf(source: string, lineno: number, colno: number): number | undefined {
  const lines = source.split('\n')
  if (lineno < 0 || lineno >= lines.length) return undefined
  let offset = 0
  for (let i = 0; i < lineno; i += 1) offset += (lines[i]?.length ?? 0) + 1
  return offset + colno
}

/** Insert `"<source unit>", ` as the first argument of each `unit(` call so the worker converts from the field's base unit. */
function withUnitHints(
  source: string,
  hints: readonly { readonly site: UnitSite; readonly hint: string }[],
): string {
  const located = hints
    .map((entry) => ({ entry, offset: offsetOf(source, entry.site.lineno, entry.site.colno) }))
    .filter(
      (item): item is { entry: (typeof hints)[number]; offset: number } =>
        item.offset !== undefined,
    )
    .toSorted((a, b) => b.offset - a.offset)
  let out = source
  for (const { entry, offset } of located) {
    if (!out.startsWith('unit', offset)) continue
    const open = out.indexOf('(', offset + 4)
    if (open < 0) continue
    out = `${out.slice(0, open + 1)}${JSON.stringify(entry.hint)}, ${out.slice(open + 1)}`
  }
  return out
}

function refText(ref: DeviceTemplateRef): string {
  return [ref.alias, ...ref.path.map(String)].join('.')
}

interface Prepared {
  readonly source: string
  readonly context: Container
  readonly trace: readonly DeviceTemplateTraceEntry[]
}

export class DeviceTemplateRenderer {
  private readonly workerPath: string
  private readonly execArgv: readonly string[] | undefined
  private readonly budgetMs: number
  private readonly now: () => number
  private worker: Worker | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRender>()
  private queue: Promise<unknown> = Promise.resolve()
  private waiting = 0
  private readonly spawnTimeoutMs: number
  private readonly maxQueue: number
  private readonly breakerThreshold: number
  private readonly breakerWindowMs: number
  private readonly breakers = new Map<string, BreakerState>()

  constructor(options: DeviceTemplateRendererOptions = {}) {
    this.workerPath = options.workerPath ?? defaultTemplateWorkerPath()
    this.execArgv = options.workerExecArgv
    this.budgetMs = options.budgetMs ?? DEVICE_TEMPLATE_BUDGET_MS
    this.now = options.now ?? Date.now
    this.spawnTimeoutMs = options.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE
    this.breakerThreshold = options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD
    this.breakerWindowMs = options.breakerWindowMs ?? DEFAULT_BREAKER_WINDOW_MS
  }

  /** Vet a template without rendering it: its references, or the refusal. */
  validate(source: string): TemplateAnalysis {
    return analyzeTemplate(source, DEVICE_TEMPLATE_FILTERS, DEVICE_TEMPLATE_MAX_LENGTH)
  }

  async render(source: string, resolver: DeviceTemplateResolver): Promise<DeviceTemplateRender> {
    const analysis = this.validate(source)
    if (!analysis.ok) return { ok: false, refusal: analysis.refusal, trace: [] }
    const prepared = this.prepare(source, analysis, resolver)
    if ('refusal' in prepared)
      return { ok: false, refusal: prepared.refusal, trace: prepared.trace }
    const open = this.breakers.get(source)
    if (open !== undefined && open.openUntil > Date.now()) {
      return {
        ok: false,
        refusal: {
          reason: 'budget-exceeded',
          message: `this template overran its ${this.budgetMs} ms budget ${open.timeouts} times in a row; it is not run again for ${Math.ceil((open.openUntil - Date.now()) / 1000)} s`,
        },
        trace: prepared.trace,
      }
    }
    if (this.waiting >= this.maxQueue) {
      return {
        ok: false,
        refusal: { reason: 'busy', message: `${this.maxQueue} renders are already waiting` },
        trace: prepared.trace,
      }
    }
    this.waiting += 1
    let response: RenderResponse
    try {
      response = await this.enqueue(prepared)
    } finally {
      this.waiting -= 1
    }
    this.noteOutcome(source, response)
    if (response.ok) {
      const poisoned: DeviceTemplateTraceEntry[] = Array.from(
        { length: response.poisoned },
        () => ({
          ref: '<expression>',
          reason: 'unavailable' as const,
        }),
      )
      return { ok: true, text: response.text, trace: [...prepared.trace, ...poisoned] }
    }
    return {
      ok: false,
      refusal: { reason: response.reason, message: response.message },
      trace: prepared.trace,
    }
  }

  private noteOutcome(source: string, response: RenderResponse): void {
    if (response.ok || response.reason !== 'timeout') {
      this.breakers.delete(source)
      return
    }
    const state = this.breakers.get(source) ?? { timeouts: 0, openUntil: 0 }
    state.timeouts += 1
    if (state.timeouts >= this.breakerThreshold) state.openUntil = Date.now() + this.breakerWindowMs
    this.breakers.delete(source)
    this.breakers.set(source, state)
    for (const key of this.breakers.keys()) {
      if (this.breakers.size <= BREAKER_MAX_TEMPLATES) break
      this.breakers.delete(key)
    }
  }

  dispose(): void {
    this.killWorker('disposed')
  }

  private prepare(
    source: string,
    analysis: Extract<TemplateAnalysis, { ok: true }>,
    resolver: DeviceTemplateResolver,
  ):
    | Prepared
    | {
        readonly refusal: DeviceTemplateRefusal
        readonly trace: readonly DeviceTemplateTraceEntry[]
      } {
    const trace: DeviceTemplateTraceEntry[] = []
    const tree = new ContextTree()
    const resolvedFor = new Map<
      string,
      { view: DeviceTemplateView; cap: string; fieldPath: readonly (string | number)[] }
    >()
    for (const ref of analysis.refs) {
      const view = resolver.viewOf(ref.alias)
      if (view === undefined) {
        trace.push({ ref: refText(ref), reason: 'unknown-alias' })
        continue
      }
      const resolved = resolveTemplateRef(view, ref.path)
      if (resolved.kind === 'ambiguous') {
        return {
          refusal: {
            reason: 'ambiguous-field',
            message: `"${ref.alias}.${resolved.field}" is ambiguous: capabilities ${resolved.caps.join(', ')} all carry "${resolved.field}"; write ${ref.alias}.<capability>.${resolved.field}`,
          },
          trace,
        }
      }
      if (resolved.kind === 'missing') {
        trace.push({ ref: refText(ref), reason: resolved.reason })
        continue
      }
      resolvedFor.set(JSON.stringify([ref.alias, ref.path]), {
        view,
        cap: resolved.cap,
        fieldPath: resolved.fieldPath,
      })
      if (resolved.value === null) trace.push({ ref: refText(ref), reason: 'unavailable' })
      tree.place(ref.alias, ref.path, plainCopy(resolved.value))
    }
    const hints = analysis.unitSites.map((site) => {
      const hit =
        site.ref === undefined
          ? undefined
          : resolvedFor.get(JSON.stringify([site.ref.alias, site.ref.path]))
      return { site, hint: hit?.view.unitOf?.(hit.cap, hit.fieldPath) ?? '' }
    })
    return { source: withUnitHints(source, hints), context: tree.root, trace }
  }

  private enqueue(prepared: Prepared): Promise<RenderResponse> {
    const run = async (): Promise<RenderResponse> => this.renderOne(prepared)
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async renderOne(prepared: Prepared): Promise<RenderResponse> {
    const id = this.nextId
    this.nextId += 1
    let worker: Worker
    try {
      worker = await this.ensureWorker()
    } catch (err) {
      return {
        id,
        ok: false,
        reason: 'render-failed',
        message: err instanceof Error ? err.message : String(err),
      }
    }
    const response = new Promise<RenderResponse>((resolve) => {
      this.pending.set(id, { worker, resolve })
    })
    const request: RenderRequest = {
      id,
      source: prepared.source,
      context: prepared.context,
      nowMs: this.now(),
    }
    try {
      worker.postMessage(request)
    } catch (err) {
      this.pending.delete(id)
      return {
        id,
        ok: false,
        reason: 'render-failed',
        message: err instanceof Error ? err.message : String(err),
      }
    }
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<RenderResponse>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          id,
          ok: false,
          reason: 'timeout',
          message: `render took longer than ${this.budgetMs} ms`,
        })
      }, this.budgetMs)
    })
    const outcome = await Promise.race([response, timeout])
    if (timer !== undefined) clearTimeout(timer)
    this.pending.delete(id)
    if (!outcome.ok && outcome.reason === 'timeout') this.killWorker('budget overrun')
    return outcome
  }

  private ensureWorker(): Promise<Worker> {
    const existing = this.worker
    if (existing !== null && this.ready !== null) return this.ready.then(() => existing)
    const limits: TemplateWorkerData = {
      allowedFilters: DEVICE_TEMPLATE_FILTERS,
      maxSourceLength: DEVICE_TEMPLATE_MAX_LENGTH + REWRITE_ALLOWANCE,
      maxOutput: DEVICE_TEMPLATE_MAX_OUTPUT,
      unavailable: DEVICE_TEMPLATE_UNAVAILABLE,
    }
    const worker = new Worker(this.workerPath, {
      workerData: limits,
      ...(this.execArgv !== undefined ? { execArgv: [...this.execArgv] } : {}),
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    })
    this.worker = worker
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('template worker did not start'))
        // Kill it and forget it: the next render spawns a fresh one instead of awaiting this forever.
        if (this.worker === worker) this.dropWorker()
        void worker.terminate()
      }, this.spawnTimeoutMs)
      worker.on('message', (message: unknown) => {
        if (isReadyMessage(message)) {
          clearTimeout(timer)
          resolve()
          return
        }
        if (isRenderResponse(message)) this.pending.get(message.id)?.resolve(message)
      })
      worker.on('error', (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
        this.failPending(worker, err instanceof Error ? err.message : String(err))
        if (this.worker === worker) this.dropWorker()
      })
      worker.on('exit', () => {
        clearTimeout(timer)
        this.failPending(worker, 'template worker exited')
        if (this.worker === worker) this.dropWorker()
      })
    })
    worker.unref()
    return this.ready.then(() => worker)
  }

  /** Fail only the renders that were running on THIS worker: a killed worker's late `exit` must not fail the next one. */
  private failPending(worker: Worker, message: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.worker !== worker) continue
      entry.resolve({ id, ok: false, reason: 'render-failed', message })
      this.pending.delete(id)
    }
  }

  private dropWorker(): void {
    this.worker = null
    this.ready = null
  }

  private killWorker(_why: string): void {
    const worker = this.worker
    this.dropWorker()
    if (worker !== null) void worker.terminate()
  }
}
