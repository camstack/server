/**
 * Corpus query helpers — work-state partition, filter AND, page slices, KPI.
 *
 * Cap providers (Task 2) load index rows, build {@link CorpusFrameRow}s, then
 * call these pure functions. No JPEG load.
 */

import type {
  RetrainCorpusFilter,
  RetrainCorpusKpi,
  RetrainCorpusKpiCameraRow,
  RetrainFrameWorkState,
  RetrainMacroClass,
} from '@camstack/types'

export type {
  RetrainCorpusFilter,
  RetrainCorpusKpi,
  RetrainCorpusKpiCameraRow,
  RetrainCorpusPage,
  RetrainFrameWorkState,
} from '@camstack/types'

export {
  RetrainCorpusFilterSchema,
  RetrainCorpusKpiCameraRowSchema,
  RetrainCorpusKpiSchema,
  RetrainCorpusPageSchema,
  RetrainFrameWorkStateSchema,
} from '@camstack/types'

/** The `{ complete }` slice {@link workStateOf} reads from a frame row. */
export interface RetrainFrameWorkStateInput {
  readonly complete: boolean
}

/** Index facts for one corpus copy — enough to filter, page and KPI. */
export interface CorpusFrameRow {
  readonly frameId: string
  readonly deviceId: number
  readonly complete: boolean
  readonly annotationCount: number
  readonly copiedAt: number
  readonly collectionIds: readonly string[]
  readonly classes: readonly RetrainMacroClass[]
}

/** A page of corpus rows before the provider maps them to wire frames. */
export interface CorpusPageRows {
  readonly rows: readonly CorpusFrameRow[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

/** Map a frame row and its saved annotation count to the exclusive work state. */
export function workStateOf(
  frame: RetrainFrameWorkStateInput,
  annotationCount: number,
): RetrainFrameWorkState {
  if (annotationCount <= 0) {
    return 'unannotated'
  }
  if (frame.complete) {
    return 'complete'
  }
  return 'annotated'
}

/** `complete(camera) / totalCorpus`, or `null` when the corpus is empty. */
export function corpusPctOfCorpus(completeOnCamera: number, totalCorpus: number): number | null {
  if (totalCorpus === 0) return null
  return completeOnCamera / totalCorpus
}

/** Every narrowing field is ANDed; omitted fields impose no constraint. */
export function filterCorpusRows(
  rows: readonly CorpusFrameRow[],
  filter: RetrainCorpusFilter,
): readonly CorpusFrameRow[] {
  const devices =
    filter.deviceIds !== undefined && filter.deviceIds.length > 0 ? new Set(filter.deviceIds) : null
  const classes =
    filter.classes !== undefined && filter.classes.length > 0 ? new Set(filter.classes) : null
  return rows.filter((row) => {
    if (devices !== null && !devices.has(row.deviceId)) return false
    if (filter.collectionId !== undefined && !row.collectionIds.includes(filter.collectionId)) {
      return false
    }
    if (classes !== null && !row.classes.some((c) => classes.has(c))) return false
    if (
      filter.workState !== undefined &&
      workStateOf(row, row.annotationCount) !== filter.workState
    ) {
      return false
    }
    return true
  })
}

/**
 * Newest copies first (`copiedAt` desc). Stable on equal timestamps by frameId
 * ascending — the order every corpus page must reproduce, including across a
 * page boundary that falls inside one timestamp.
 */
export function compareCorpusNewestFirst(
  a: Pick<CorpusFrameRow, 'copiedAt' | 'frameId'>,
  b: Pick<CorpusFrameRow, 'copiedAt' | 'frameId'>,
): number {
  if (a.copiedAt !== b.copiedAt) return b.copiedAt - a.copiedAt
  return a.frameId < b.frameId ? -1 : a.frameId > b.frameId ? 1 : 0
}

/** Newest copies first. See {@link compareCorpusNewestFirst}. */
export function sortCorpusRowsNewestFirst(
  rows: readonly CorpusFrameRow[],
): readonly CorpusFrameRow[] {
  return [...rows].toSorted(compareCorpusNewestFirst)
}

/** 1-based page slice. An empty match is `{ rows: [], total: 0, … }`. */
export function paginateCorpusRows(
  rows: readonly CorpusFrameRow[],
  page: number,
  pageSize: number,
): CorpusPageRows {
  const safePage = page < 1 ? 1 : page
  const safeSize = pageSize < 1 ? 1 : pageSize
  const start = (safePage - 1) * safeSize
  return {
    rows: rows.slice(start, start + safeSize),
    total: rows.length,
    page: safePage,
    pageSize: safeSize,
  }
}

/** Global + per-camera KPI; classification always via {@link workStateOf}. */
export function aggregateCorpusKpi(rows: readonly CorpusFrameRow[]): RetrainCorpusKpi {
  let unannotated = 0
  let annotated = 0
  let complete = 0
  const perCamera = new Map<number, { unannotated: number; annotated: number; complete: number }>()
  for (const row of rows) {
    const state = workStateOf(row, row.annotationCount)
    const cam = perCamera.get(row.deviceId) ?? { unannotated: 0, annotated: 0, complete: 0 }
    if (state === 'unannotated') {
      unannotated += 1
      cam.unannotated += 1
    } else if (state === 'annotated') {
      annotated += 1
      cam.annotated += 1
    } else {
      complete += 1
      cam.complete += 1
    }
    perCamera.set(row.deviceId, cam)
  }
  const total = rows.length
  const cameras: RetrainCorpusKpiCameraRow[] = [...perCamera.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([deviceId, counts]) => ({
      deviceId,
      unannotated: counts.unannotated,
      annotated: counts.annotated,
      complete: counts.complete,
      pctOfCorpus: corpusPctOfCorpus(counts.complete, total),
    }))
  return { total, unannotated, annotated, complete, cameras }
}
