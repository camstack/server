/**
 * `fetch_retrain_export` — download the annotated retrain archive
 * (`pipelineAnalytics.getRetrainExportUrl`, then the data-plane GET it names)
 * into `<workspace>/scratchpad/retrain-export/`. Read-only on the cluster: the
 * hub generates the tar on the fly, paced, one JPEG in memory at a time; the
 * mutation gate does not apply. An admin login is required (the route is admin-only).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { confine } from '../fs-confine.js'
import type { OpsHub } from '../ops/hub.js'
import { parseWire } from '../ops/wire.js'

export const DEFAULT_EXPORT_MAX_MB = 2048
export const HARD_EXPORT_MAX_MB = 8192

export interface FetchExportArgs {
  deviceIds?: number[]
  collectionId?: string
  batchId?: string
  completeOnly?: boolean
  workState?: 'unannotated' | 'annotated' | 'complete'
  classes?: string[]
  layout?: 'frames' | 'crops'
  name?: string
  maxMegabytes?: number
}

export const FetchExportArgsSchema: z.ZodType<FetchExportArgs> = z.object({
  deviceIds: z.array(z.number().int()).max(50).optional(),
  collectionId: z.string().optional(),
  batchId: z.string().optional(),
  completeOnly: z.boolean().optional(),
  workState: z.enum(['unannotated', 'annotated', 'complete']).optional(),
  classes: z.array(z.string()).max(8).optional(),
  layout: z.enum(['frames', 'crops']).optional(),
  /** File name stem under scratchpad/retrain-export/; defaults to a timestamp. */
  name: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,80}$/)
    .optional(),
  maxMegabytes: z.number().int().positive().max(HARD_EXPORT_MAX_MB).optional(),
})

const UrlSchema = z.looseObject({ url: z.string() })
const URL_PATH = 'pipelineAnalytics.getRetrainExportUrl'

export interface FetchExportResult {
  readonly path: string
  readonly bytes: number
  readonly next: string
}

export async function fetchRetrainExport(
  root: string,
  hub: OpsHub,
  args: FetchExportArgs,
  now: () => Date = () => new Date(),
): Promise<FetchExportResult> {
  const stem = args.name ?? `export-${now().toISOString().replace(/[:.]/g, '-')}`
  const dest = confine(root, path.join('scratchpad', 'retrain-export', `${stem}.tar`))
  const { maxMegabytes } = args
  const filter = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== 'name' && key !== 'maxMegabytes'),
  )
  const answer = parseWire(UrlSchema, await hub.query(URL_PATH, filter), URL_PATH)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const maxBytes = (maxMegabytes ?? DEFAULT_EXPORT_MAX_MB) * 1024 * 1024
  const { bytes } = await hub.download(answer.url, dest, maxBytes)
  return {
    path: path.relative(root, dest),
    bytes,
    next: 'Pass this path as exportPath to eval_model.',
  }
}
