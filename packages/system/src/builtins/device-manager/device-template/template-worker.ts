/**
 * The render worker thread (D1021). nunjucks does not sandbox, so a template
 * only ever runs HERE: a fresh environment with no globals and only the
 * allow-listed filters, over frozen null-prototype data, after the grammar
 * check has run again. The host measures the wall-time budget and terminates
 * this thread when it is overrun.
 *
 * Lean by design (D453): no value import from `@camstack/types`'s barrel; the
 * limits arrive in `workerData`.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { createTemplateEnvironment, type TemplateEnvironment } from './nunjucks-internals.js'
import {
  addChecked,
  concatChecked,
  defaultFilter,
  formatFilter,
  timeFilter,
  makeAgoFilter,
  makePrinter,
  makeSinceFilter,
  type Printer,
  rangeGlobal,
  roundFilter,
  unitFilter,
} from './template-filters.js'
import { analyzeTemplate } from './template-grammar.js'
import {
  isRenderRequest,
  type RenderResponse,
  type TemplateWorkerData,
} from './template-protocol.js'

function isWorkerData(value: unknown): value is TemplateWorkerData {
  if (typeof value !== 'object' || value === null) return false
  return (
    Array.isArray(Reflect.get(value, 'allowedFilters')) &&
    typeof Reflect.get(value, 'maxSourceLength') === 'number' &&
    typeof Reflect.get(value, 'maxOutput') === 'number' &&
    typeof Reflect.get(value, 'unavailable') === 'string'
  )
}

function stringsOf(value: readonly unknown[]): readonly string[] {
  return value.filter((item): item is string => typeof item === 'string')
}

/** Rebuild structured-clone data as frozen null-prototype objects: nothing to reach through. */
function freezeData(value: unknown, depth = 0): unknown {
  if (depth > 16) return undefined
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeData(item, depth + 1)))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value)) out[key] = freezeData(Reflect.get(value, key), depth + 1)
    return Object.freeze(out)
  }
  return value
}

function freezeContext(context: Readonly<Record<string, unknown>>): object {
  const out: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(context)) out[key] = freezeData(context[key])
  return Object.freeze(out)
}

const BUILTIN_FILTERS: readonly string[] = [
  'upper',
  'lower',
  'title',
  'capitalize',
  'trim',
  'abs',
  'int',
  'float',
  'length',
  'join',
  'replace',
  'first',
  'last',
  'sort',
  'reverse',
  'sum',
  'string',
  'list',
  'truncate',
]

function environmentFor(nowMs: number, printer: Printer): TemplateEnvironment {
  return createTemplateEnvironment({
    print: printer.print,
    keepBuiltinFilters: BUILTIN_FILTERS,
    globals: { range: rangeGlobal },
    add: addChecked,
    concat: concatChecked,
    filters: {
      d: defaultFilter,
      unit: unitFilter,
      round: roundFilter,
      default: defaultFilter,
      format: formatFilter,
      time: timeFilter,
      since: makeSinceFilter(nowMs),
      ago: makeAgoFilter(nowMs),
    },
  })
}

// Not exported: it patches nunjucks' process-global runtime, so it must only ever run in this thread.
function renderInWorker(
  request: {
    readonly id: number
    readonly source: string
    readonly context: Readonly<Record<string, unknown>>
    readonly nowMs: number
  },
  limits: TemplateWorkerData,
): RenderResponse {
  const analysis = analyzeTemplate(request.source, limits.allowedFilters, limits.maxSourceLength)
  if (!analysis.ok) {
    return {
      id: request.id,
      ok: false,
      reason: analysis.refusal.reason,
      message: analysis.refusal.message,
    }
  }
  try {
    const printer = makePrinter(limits.unavailable)
    const text = environmentFor(request.nowMs, printer).render(
      request.source,
      freezeContext(request.context),
    )
    if (text.length > limits.maxOutput) {
      return {
        id: request.id,
        ok: false,
        reason: 'output-too-large',
        message: `output is longer than ${limits.maxOutput} characters`,
      }
    }
    return { id: request.id, ok: true, text, poisoned: printer.poisoned() }
  } catch (err) {
    return {
      id: request.id,
      ok: false,
      reason: 'render-failed',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

if (parentPort !== null && isWorkerData(workerData)) {
  const port = parentPort
  const limits: TemplateWorkerData = {
    allowedFilters: stringsOf(workerData.allowedFilters),
    maxSourceLength: workerData.maxSourceLength,
    maxOutput: workerData.maxOutput,
    unavailable: workerData.unavailable,
  }
  port.on('message', (message: unknown) => {
    if (!isRenderRequest(message)) return
    port.postMessage(renderInWorker(message, limits))
  })
  port.postMessage({ ready: true })
}
