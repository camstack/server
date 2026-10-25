/**
 * Frames corpus filter ↔ URL search params (`replaceState`).
 *
 * Keys: `workState`, `camera` (csv device ids), `collection` (singular),
 * `class` (csv macro classes), `page` (1-based). Page size is not in the URL.
 */
import type { RetrainFrameWorkState, RetrainMacroClass } from '@camstack/types'

const WORK_STATES: ReadonlySet<string> = new Set(['unannotated', 'annotated', 'complete'])
const MACRO_CLASSES: ReadonlySet<string> = new Set([
  'person',
  'vehicle',
  'animal',
  'package',
  'face',
  'plate',
])

export interface CorpusUrlFilter {
  readonly workState: RetrainFrameWorkState | undefined
  readonly deviceIds: readonly number[]
  readonly collectionId: string | undefined
  readonly classes: readonly RetrainMacroClass[]
  readonly page: number
}

export const DEFAULT_CORPUS_URL_FILTER: CorpusUrlFilter = {
  workState: undefined,
  deviceIds: [],
  collectionId: undefined,
  classes: [],
  page: 1,
}

function parseCsv(raw: string | null): readonly string[] {
  if (raw === null || raw.trim() === '') return []
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function parseDeviceIds(raw: string | null): readonly number[] {
  const out: number[] = []
  for (const part of parseCsv(raw)) {
    const n = Number.parseInt(part, 10)
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

function isMacroClass(value: string): value is RetrainMacroClass {
  return MACRO_CLASSES.has(value)
}

function isWorkState(value: string): value is RetrainFrameWorkState {
  return WORK_STATES.has(value)
}

function parseClasses(raw: string | null): readonly RetrainMacroClass[] {
  const out: RetrainMacroClass[] = []
  for (const part of parseCsv(raw)) {
    if (!isMacroClass(part) || out.includes(part)) continue
    out.push(part)
  }
  return out
}

function parseWorkState(raw: string | null): RetrainFrameWorkState | undefined {
  if (raw === null || raw === '') return undefined
  return isWorkState(raw) ? raw : undefined
}

function parsePage(raw: string | null): number {
  if (raw === null || raw === '') return 1
  const n = Number.parseInt(raw, 10)
  return Number.isInteger(n) && n >= 1 ? n : 1
}

/** Read corpus filter fields from the current location search params. */
export function corpusFilterFromSearchParams(params: URLSearchParams): CorpusUrlFilter {
  const collectionRaw = params.get('collection')?.trim() ?? ''
  return {
    workState: parseWorkState(params.get('workState')),
    deviceIds: parseDeviceIds(params.get('camera')),
    collectionId: collectionRaw.length > 0 ? collectionRaw : undefined,
    classes: parseClasses(params.get('class')),
    page: parsePage(params.get('page')),
  }
}

/**
 * Write corpus filter fields onto `params` in place. Clears keys when they
 * hold the default (so the URL stays short). Leaves unrelated keys alone.
 */
export function applyCorpusFilterToSearchParams(
  params: URLSearchParams,
  filter: CorpusUrlFilter,
): void {
  if (filter.workState === undefined) params.delete('workState')
  else params.set('workState', filter.workState)

  if (filter.deviceIds.length === 0) params.delete('camera')
  else params.set('camera', filter.deviceIds.join(','))

  if (filter.collectionId === undefined || filter.collectionId === '') {
    params.delete('collection')
  } else {
    params.set('collection', filter.collectionId)
  }

  if (filter.classes.length === 0) params.delete('class')
  else params.set('class', filter.classes.join(','))

  if (filter.page <= 1) params.delete('page')
  else params.set('page', String(filter.page))
}

/** Replace the location search with the given corpus filter (keeps other keys). */
export function replaceCorpusFilterInUrl(filter: CorpusUrlFilter): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  applyCorpusFilterToSearchParams(url.searchParams, filter)
  window.history.replaceState({}, '', url.toString())
}
