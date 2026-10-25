/**
 * One page of the retrain corpus without loading every copy and every box.
 *
 * What is pushed into the records engine:
 * - no class / collection / work-state filter — `pageByClock` on `records_kind_at`
 *   (or `records_kind_device_at` per camera) reads the clock prefix of the page,
 *   and `count` is the same filter's `COUNT(*)`;
 * - `classes` — covering `COUNT GROUP BY mediaKey` on `class_media`, one class
 *   at a time; the page is the frames those ids name;
 * - `deviceIds` — header `deviceId` on the clock index, merged in corpus order.
 *
 * What cannot be a single frame-table predicate, and how it is bounded:
 * - `collectionId` — membership index `collection_added` names that collection's
 *   frame ids only; those frame rows are read, not the corpus;
 * - `workState` `annotated` / `complete` — covering `GROUP BY mediaKey` names
 *   every frame that has a box; those frame rows are read (a complete flag is
 *   not on the annotation). Unannotated frames are not. Annotation bodies are
 *   not. `unannotated` uses the same id set: total is `count(frames) - those
 *   ids that are still frames`, and the page walks the clock index skipping
 *   them until the page is full;
 * - a class filter plus `unannotated` matches nothing (a class is a box).
 *
 * Annotation bodies (`listByFrames`) are read for the page's ids only — the
 * wire frame's review needs them, and a mixed page needs the counts for
 * `workStateOf`.
 */
import type {
  IScopedLogger,
  RetrainCorpusFilter,
  RetrainCorpusPage,
  RetrainFrameWorkState,
  RetrainFrame as WireFrame,
} from '@camstack/types'
import type { RetrainAnnotationStore } from './retrain-annotation-store.js'
import { compareCorpusNewestFirst, workStateOf } from './retrain-corpus-query.js'
import { corpusDeviceIds } from './retrain-corpus-walk.js'
import type { RetrainFrame, RetrainFrameStore } from './retrain-frame-store.js'
import type { RetrainMembershipPort } from './retrain-service.js'

export interface CorpusPageLoadDeps {
  readonly frames: RetrainFrameStore
  readonly annotations: RetrainAnnotationStore
  readonly memberships: RetrainMembershipPort | undefined
  readonly logger: IScopedLogger
}

type WireFrames = (copies: readonly RetrainFrame[]) => Promise<readonly WireFrame[]>

function clampPage(filter: RetrainCorpusFilter): {
  readonly page: number
  readonly pageSize: number
  readonly offset: number
} {
  const page = filter.page < 1 ? 1 : filter.page
  const pageSize = filter.pageSize < 1 ? 1 : filter.pageSize
  return { page, pageSize, offset: (page - 1) * pageSize }
}

function emptyPage(page: number, pageSize: number): RetrainCorpusPage {
  return { frames: [], total: 0, page, pageSize }
}

function intersectIds(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const id of left) if (right.has(id)) out.add(id)
  return out
}

async function annotatedIdSet(
  annotations: RetrainAnnotationStore,
  deviceIds: readonly number[] | undefined,
): Promise<ReadonlySet<string>> {
  const devices = corpusDeviceIds(deviceIds)
  if (devices === undefined) return annotations.annotatedFrameIds()
  const ids = new Set<string>()
  for (const deviceId of devices) {
    for (const id of await annotations.annotatedFrameIds(deviceId)) ids.add(id)
  }
  return ids
}

async function countsForPage(
  annotations: RetrainAnnotationStore,
  frameIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>()
  if (frameIds.length === 0) return counts
  for (const row of await annotations.listByFrames(frameIds)) {
    counts.set(row.mediaKey, (counts.get(row.mediaKey) ?? 0) + 1)
  }
  return counts
}

async function toPage(
  slice: readonly RetrainFrame[],
  total: number,
  page: number,
  pageSize: number,
  annotations: RetrainAnnotationStore,
  toWire: WireFrames,
  knownState: RetrainFrameWorkState | undefined,
): Promise<RetrainCorpusPage> {
  if (slice.length === 0) return { frames: [], total, page, pageSize }
  const counts =
    knownState === undefined
      ? await countsForPage(
          annotations,
          slice.map((frame) => frame.frameId),
        )
      : null
  const wire = await toWire(slice)
  const byId = new Map(wire.map((frame) => [frame.frameId, frame]))
  const frames = slice.flatMap((row) => {
    const frame = byId.get(row.frameId)
    if (frame === undefined) return []
    const workState =
      knownState ?? workStateOf({ complete: row.complete }, counts?.get(row.frameId) ?? 0)
    return [{ ...frame, workState }]
  })
  return { frames, total, page, pageSize }
}

function onDevice(frame: RetrainFrame, deviceIds: readonly number[] | undefined): boolean {
  const devices = corpusDeviceIds(deviceIds)
  return devices === undefined || devices.includes(frame.deviceId)
}

function matchesWorkState(
  frame: RetrainFrame,
  workState: RetrainFrameWorkState | undefined,
  annotated: ReadonlySet<string> | null,
  classConstrained: boolean,
): boolean {
  if (workState === undefined) return true
  const hasBox = classConstrained || (annotated?.has(frame.frameId) ?? false)
  if (!hasBox) return workState === 'unannotated'
  if (workState === 'unannotated') return false
  if (workState === 'complete') return frame.complete
  return !frame.complete
}

async function pageConstrained(
  deps: CorpusPageLoadDeps,
  filter: RetrainCorpusFilter,
  ids: ReadonlySet<string>,
  classConstrained: boolean,
  toWire: WireFrames,
): Promise<RetrainCorpusPage> {
  const { page, pageSize, offset } = clampPage(filter)
  if (classConstrained && filter.workState === 'unannotated') return emptyPage(page, pageSize)
  const annotated =
    filter.workState !== undefined && !classConstrained
      ? await annotatedIdSet(deps.annotations, filter.deviceIds)
      : null
  const matched = (await deps.frames.getMany([...ids])).filter(
    (frame) =>
      onDevice(frame, filter.deviceIds) &&
      matchesWorkState(frame, filter.workState, annotated, classConstrained),
  )
  const ordered = [...matched].toSorted(compareCorpusNewestFirst)
  return toPage(
    ordered.slice(offset, offset + pageSize),
    ordered.length,
    page,
    pageSize,
    deps.annotations,
    toWire,
    filter.workState,
  )
}

async function pageByWorkState(
  deps: CorpusPageLoadDeps,
  filter: RetrainCorpusFilter,
  toWire: WireFrames,
): Promise<RetrainCorpusPage> {
  const { page, pageSize, offset } = clampPage(filter)
  const workState = filter.workState
  if (workState === undefined) {
    const total = await deps.frames.countInDevices(filter.deviceIds)
    const slice = await deps.frames.pageCorpus({
      deviceIds: filter.deviceIds,
      offset,
      limit: pageSize,
      keep: () => true,
    })
    return toPage(slice, total, page, pageSize, deps.annotations, toWire, undefined)
  }
  const rawIds = await annotatedIdSet(deps.annotations, filter.deviceIds)
  const annotatedFrames = (await deps.frames.getMany([...rawIds])).filter((frame) =>
    onDevice(frame, filter.deviceIds),
  )
  if (workState === 'unannotated') {
    const annotatedIds = new Set(annotatedFrames.map((frame) => frame.frameId))
    const total = (await deps.frames.countInDevices(filter.deviceIds)) - annotatedIds.size
    const slice = await deps.frames.pageCorpus({
      deviceIds: filter.deviceIds,
      offset,
      limit: pageSize,
      keep: (frame) => !annotatedIds.has(frame.frameId),
    })
    return toPage(slice, total, page, pageSize, deps.annotations, toWire, 'unannotated')
  }
  const matched = annotatedFrames.filter((frame) =>
    workState === 'complete' ? frame.complete : !frame.complete,
  )
  const ordered = [...matched].toSorted(compareCorpusNewestFirst)
  return toPage(
    ordered.slice(offset, offset + pageSize),
    ordered.length,
    page,
    pageSize,
    deps.annotations,
    toWire,
    workState,
  )
}

/** The corpus grid page. See the file comment for which filters hit an index. */
export async function loadRetrainCorpusPage(
  deps: CorpusPageLoadDeps,
  filter: RetrainCorpusFilter,
  toWire: WireFrames,
): Promise<RetrainCorpusPage> {
  const { page, pageSize } = clampPage(filter)
  const classes =
    filter.classes !== undefined && filter.classes.length > 0 ? filter.classes : undefined
  let ids: ReadonlySet<string> | null = null
  if (classes !== undefined) ids = await deps.annotations.frameIdsWithAnyClass(classes)
  if (filter.collectionId !== undefined) {
    const memberships = deps.memberships
    if (memberships?.listFrameIds === undefined) {
      deps.logger.warn('retrain corpus page dropped — collection membership cannot be queried', {
        meta: { collectionId: filter.collectionId },
      })
      return emptyPage(page, pageSize)
    }
    const members = new Set(await memberships.listFrameIds(filter.collectionId))
    ids = ids === null ? members : intersectIds(ids, members)
  }
  if (ids !== null) {
    if (ids.size === 0) return emptyPage(page, pageSize)
    return pageConstrained(deps, filter, ids, classes !== undefined, toWire)
  }
  return pageByWorkState(deps, filter, toWire)
}
