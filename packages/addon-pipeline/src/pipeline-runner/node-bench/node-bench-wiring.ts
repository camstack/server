/**
 * Binds the node benchmark host (D791) to the runner's in-process executor:
 * every call is pinned to THIS node, so the frame never leaves the process
 * group that owns it (D9) and the numbers are this node's.
 */
import os from 'node:os'
import {
  type AddonContext,
  buildBenchStepTree,
  MODEL_FORMATS,
  type ModelFormat,
  type NodeBenchFingerprint,
  nodePin,
} from '@camstack/types'
import { getSharp } from '../../shared/lazy-sharp.js'
import { startStallSampler } from '../capacity/stall-sampler.js'
import { loadBenchFrames } from './bench-frames.js'
import type { BenchFrame } from './node-bench-driver.js'
import { NodeBenchHost } from './node-bench-host.js'

const DETECTOR_ADDON = 'object-detection'
/** A stall this long fails a ramp step (the frame interval at 4 fps). */
const BENCH_STALL_MS = 250

function isModelFormat(value: string): value is ModelFormat {
  return (MODEL_FORMATS as readonly string[]).includes(value)
}

export function createNodeBenchHost(deps: {
  readonly nodeId: string
  readonly ctx: () => AddonContext
  readonly activeCameraIds: () => readonly number[]
  readonly pipelineVersion: string | null
}): NodeBenchHost {
  const api = () => {
    const a = deps.ctx().api
    if (!a) throw new Error('node bench: ctx.api unavailable')
    return a
  }
  const pin = () => nodePin(deps.nodeId)
  const log = deps.ctx().logger

  const decodeJpeg = async (jpeg: Uint8Array, maxWidth: number): Promise<BenchFrame> => {
    const sharp = await getSharp()
    const { data, info } = await sharp(Buffer.from(jpeg))
      .resize({ width: maxWidth, withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return { data: new Uint8Array(data), width: info.width, height: info.height }
  }

  return new NodeBenchHost({
    nodeId: deps.nodeId,
    loadFrames: () =>
      loadBenchFrames({
        dataDir: deps.ctx().dataDir,
        ensureFfmpeg: () => deps.ctx().deps.ensureFfmpeg(),
        fetch: globalThis.fetch,
        referenceImages: async () => {
          const list = await api().pipelineExecutor.listReferenceImages.query(undefined, pin())
          const out: Uint8Array[] = []
          for (const entry of list) {
            const img = await api().pipelineExecutor.getReferenceImage.query(
              { filename: entry.filename },
              pin(),
            )
            if (img) out.push(new Uint8Array(Buffer.from(img.base64, 'base64')))
          }
          return out
        },
        decodeJpeg,
        log: (message, meta) => log.info(message, meta ? { meta } : undefined),
      }),
    dispatch: async ({ steps, deviceKey, plane, frame }) => {
      const result = await api().pipelineExecutor.runPipeline.mutate(
        {
          steps: [...steps],
          frame: {
            data: frame.data,
            format: 'rgb' as const,
            width: frame.width,
            height: frame.height,
            timestamp: Date.now(),
          },
          plane,
          deviceKey,
        },
        pin(),
      )
      return {
        shed: result.shed === true,
        detections: result.detections.length,
        inferMs: result.debug?.totalInferenceMs ?? 0,
        predictMs: result.debug?.predictMs ?? 0,
        stepsRan: [
          ...new Set(
            (result.debug?.stepTimings ?? []).filter((t) => t.ms > 0).map((t) => t.source),
          ),
        ],
      }
    },
    pipelineSteps: async (rootModelId, stepIds) => {
      const schema = await api().pipelineExecutor.getSchema.query(undefined, pin())
      return buildBenchStepTree(schema, rootModelId, stepIds)
    },
    fingerprint: async (deviceKeys): Promise<NodeBenchFingerprint> => {
      const pools: Record<string, NodeBenchFingerprint['pools'][string]> = {}
      for (const deviceKey of deviceKeys) {
        try {
          const t = await api().pipelineExecutor.getEffectiveTuning.query({ deviceKey }, pin())
          pools[deviceKey] = {
            runtime: t.runtime,
            numWorkers: t.numWorkers,
            concurrency: t.concurrency,
            batchMode: t.batchMode,
          }
        } catch {
          // an unanswered pool is left out — it can never make a result stale
        }
      }
      return {
        pipelineVersion: deps.pipelineVersion,
        cpuModel: os.cpus()[0]?.model?.trim() ?? null,
        ramGb: Math.round(os.totalmem() / 1e9),
        os: `${os.platform()}-${os.arch()}`,
        pools,
      }
    },
    installedDetectorModels: async () => {
      const models = await api().pipelineExecutor.getAddonModels.query(
        { addonId: DETECTOR_ADDON },
        pin(),
      )
      const out = new Set<string>()
      for (const m of models) {
        for (const [format, status] of Object.entries(m.formats)) {
          if (status?.downloaded === true) out.add(`${m.id}/${format}`)
        }
      }
      return out
    },
    deleteDetectorModel: async (key) => {
      const [modelId = '', format = ''] = key.split('/')
      if (!isModelFormat(format)) return
      await api().pipelineExecutor.deleteModel.mutate(
        { addonId: DETECTOR_ADDON, modelId, format },
        pin(),
      )
    },
    activeCameraIds: deps.activeCameraIds,
    startStallSampler: () => startStallSampler({ reportThresholdMs: BENCH_STALL_MS }),
    log: (level, message, meta) => log[level](message, meta ? { meta } : undefined),
  })
}
