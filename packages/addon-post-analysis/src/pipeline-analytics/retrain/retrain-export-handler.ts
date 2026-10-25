/**
 * Data-plane handler for the ANNOTATED dataset archive.
 *
 * `/addon/<addonId>/retrain-export?deviceIds=101,102`
 *
 * The bytes leave through the data plane and not the cap for the reason the
 * training export already does: the cap channel is unary, and an archive
 * base64'd through an RPC envelope is held whole in memory twice on a hub this
 * repo has already OOM'd once. Here the handler owns the real `ServerResponse`,
 * so backpressure and client-disconnect are Node's problem.
 *
 * Admin-only (level declared in `../data-plane-access.ts`). Deliberately NO `Accept-Ranges` — the archive is generated
 * on the fly, and a resumed download would silently receive a DIFFERENT archive
 * if an annotation changed in between.
 *
 * `HEAD` answers the cheap question: how many frames and annotations, without
 * moving a byte.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  DataPlaneHandler,
  IScopedLogger,
  RetrainExportFilter,
  RetrainExportLayout,
  RetrainFrameWorkState,
  RetrainMacroClass,
} from '@camstack/types'
import {
  type RetrainCropCutter,
  type RetrainExportPlan,
  writeRetrainArchiveTo,
} from './retrain-archive-writer.js'
import type { RetrainFrame } from './retrain-frame-store.js'
import { isRetrainMacroClass } from './retrain-taxonomy.js'

function parseExportWorkState(raw: string): RetrainFrameWorkState | undefined {
  if (raw === 'unannotated' || raw === 'annotated' || raw === 'complete') return raw
  return undefined
}

function parseExportClasses(raw: string): readonly RetrainMacroClass[] {
  const out: RetrainMacroClass[] = []
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (isRetrainMacroClass(trimmed) && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

export { RETRAIN_MANIFEST_ENTRY, type RetrainExportPlan } from './retrain-archive-writer.js'

/** What one request asks for: which frames, and in which layout. */
export interface RetrainExportRequest {
  readonly filter: RetrainExportFilter
  readonly layout: RetrainExportLayout
}

export interface RetrainExportHandlerDeps {
  /** Index reads only — no blob is touched to produce this. */
  readonly buildPlan: (request: RetrainExportRequest) => Promise<RetrainExportPlan>
  readonly readFrame: (frame: RetrainFrame) => Promise<Buffer | null>
  readonly cutCrop: RetrainCropCutter
  /** Stamp the batch id onto the annotations the archive actually carried. */
  readonly markExported: (frameIds: readonly string[], batchId: string) => Promise<void>
  readonly logger: IScopedLogger
  readonly now: () => number
}

/** The export request a URL carries (`getRetrainExportUrl` composes it). */
export function parseRetrainExportRequest(url: string): RetrainExportRequest {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  const params = new URLSearchParams(query)
  const deviceIds = parseRetrainDeviceIds(url)
  const frameIds = (params.get('frameIds') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  const collectionIds = (params.get('collectionIds') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  const collectionId = params.get('collectionId')?.trim() ?? ''
  const classes = parseExportClasses(params.get('classes') ?? '')
  const workState = parseExportWorkState(params.get('workState')?.trim() ?? '')
  const batchId = params.get('batchId')?.trim() ?? ''
  return {
    filter: {
      ...(deviceIds.length > 0 ? { deviceIds: [...deviceIds] } : {}),
      ...(frameIds.length > 0 ? { frameIds } : {}),
      ...(collectionIds.length > 0 ? { collectionIds } : {}),
      ...(collectionId.length > 0 ? { collectionId } : {}),
      ...(classes.length > 0 ? { classes: [...classes] } : {}),
      ...(workState !== undefined ? { workState } : {}),
      ...(batchId.length > 0 ? { batchId } : {}),
      ...(params.get('completeOnly') === '1' ? { completeOnly: true } : {}),
    },
    layout: params.get('layout') === 'crops' ? 'crops' : 'frames',
  }
}

/** The query string `parseRetrainExportRequest` reads back. */
export function retrainExportQuery(request: RetrainExportRequest): string {
  const params = new URLSearchParams()
  const { filter } = request
  if (filter.deviceIds !== undefined && filter.deviceIds.length > 0) {
    params.set('deviceIds', filter.deviceIds.join(','))
  }
  if (filter.frameIds !== undefined && filter.frameIds.length > 0) {
    params.set('frameIds', filter.frameIds.join(','))
  }
  if (filter.collectionIds !== undefined && filter.collectionIds.length > 0) {
    params.set('collectionIds', filter.collectionIds.join(','))
  }
  if (filter.collectionId !== undefined) params.set('collectionId', filter.collectionId)
  if (filter.workState !== undefined) params.set('workState', filter.workState)
  if (filter.classes !== undefined && filter.classes.length > 0) {
    params.set('classes', filter.classes.join(','))
  }
  if (filter.batchId !== undefined) params.set('batchId', filter.batchId)
  if (filter.completeOnly === true) params.set('completeOnly', '1')
  if (request.layout === 'crops') params.set('layout', 'crops')
  const text = params.toString()
  return text.length > 0 ? `?${text}` : ''
}

function parseRetrainDeviceIds(url: string): readonly number[] {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  const raw = new URLSearchParams(query).get('deviceIds')
  if (raw === null || raw.trim() === '') return []
  const out: number[] = []
  for (const part of raw.split(',')) {
    const n = Number.parseInt(part.trim(), 10)
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

function retrainArchiveFilename(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-')
  return `camstack-retrain-${stamp}.tar`.replace(/[\r\n"]/g, '')
}

export function createRetrainExportHandler(deps: RetrainExportHandlerDeps): DataPlaneHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }

    const request = parseRetrainExportRequest(req.url ?? '')
    let plan: RetrainExportPlan
    try {
      plan = await deps.buildPlan(request)
    } catch (err) {
      deps.logger.warn('retrain export plan failed', { meta: { error: String(err) } })
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('retrain export plan failed')
      return
    }

    res.writeHead(200, {
      'content-type': 'application/x-tar',
      'content-disposition': `attachment; filename="${retrainArchiveFilename(deps.now())}"`,
      'cache-control': 'no-store',
      'x-camstack-retrain-frames': String(plan.manifest.frameCount),
      'x-camstack-retrain-annotations': String(plan.manifest.annotationCount),
      'x-camstack-retrain-model-errors': String(plan.manifest.modelErrorCount),
      'x-camstack-retrain-batch': plan.manifest.batchId,
      'x-camstack-retrain-layout': plan.manifest.layout,
    })
    if (method === 'HEAD') {
      res.end()
      return
    }

    // Honour write()'s return and await drain (D447).
    const write = (chunk: Buffer): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const ok = res.write(chunk, (err) => {
          if (err) reject(err)
          else if (ok) resolve()
        })
        if (!ok) res.once('drain', resolve)
      })

    await writeRetrainArchiveTo({
      plan,
      readFrame: deps.readFrame,
      cutCrop: deps.cutCrop,
      sink: { write },
      markExported: deps.markExported,
      logger: deps.logger,
      now: deps.now,
    })
    await new Promise<void>((resolve) => {
      res.end(resolve)
    })
  }
}
