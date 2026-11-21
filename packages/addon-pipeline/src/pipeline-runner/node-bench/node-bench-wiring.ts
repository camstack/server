/**
 * Binds the node benchmark host (D791) to the runner's in-process executor:
 * every call is pinned to THIS node, so the frame never leaves the process
 * group that owns it (D9) and the numbers are this node's.
 *
 * The `decode` measurement (D1078) is bound here too: the stream is encoded
 * with the node's ffmpeg, served on the loopback by the broker's restream
 * code, and decoded by the runner's own decode-worker fork with the hwaccel
 * offer and lease knobs a session gets.
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
import { WasmMotionDetector } from '../../motion-wasm/wasm-motion-detector.js'
import type { ForkedChildLike } from '../../session-decode/session-decode-coordinator.js'
import type { WorkerLeaseKnobs } from '../../session-decode/native-lease-knobs.js'
import type { SessionHwaccelOffer } from '../../session-decode/session-hwaccel.js'
import type { VideoFrameSource } from '../../session-decode/video-frame-generator.js'
import { getSharp } from '../../shared/lazy-sharp.js'
import { startStallSampler } from '../capacity/stall-sampler.js'
import { type BenchFrameDeps, ensureBenchClip, loadBenchFrames } from './bench-frames.js'
import { type DecodeBenchMotionPass, openDecodeBenchRig } from './decode-bench-rig.js'
import { ensureDecodeBenchSource, runFfmpegToFile } from './decode-bench-source.js'
import { type BenchFrame, PIPELINE_RAM_FREE_MIN_PCT } from './node-bench-driver.js'
import { NodeBenchHost } from './node-bench-host.js'

const DETECTOR_ADDON = 'object-detection'
/** A stall this long fails a ramp step (the frame interval at 4 fps). */
const BENCH_STALL_MS = 250

function isModelFormat(value: string): value is ModelFormat {
  return (MODEL_FORMATS as readonly string[]).includes(value)
}

/** The runner's session decode path, as the `decode` measurement borrows it. */
export interface NodeBenchDecodePath {
  /** Fork one decode worker: killed with the runner, claimed against no camera. */
  readonly fork: (source: VideoFrameSource) => ForkedChildLike
  readonly lease: () => WorkerLeaseKnobs
  readonly hwaccel: () => SessionHwaccelOffer
  /** Bring the lease knobs and the hwaccel offer up to date, as a session spawn does. */
  readonly refresh: () => Promise<void>
}

/** Refuse the next decode worker while the node is under the free-RAM limit. */
function ramAdmission(): string | null {
  const freePct = Math.round((os.freemem() / os.totalmem()) * 1000) / 10
  return freePct < PIPELINE_RAM_FREE_MIN_PCT
    ? `ram free ${Math.round(freePct)}% < ${PIPELINE_RAM_FREE_MIN_PCT}%`
    : null
}

export function createNodeBenchHost(deps: {
  readonly nodeId: string
  readonly ctx: () => AddonContext
  readonly activeCameraIds: () => readonly number[]
  readonly pipelineVersion: string | null
  readonly decode: NodeBenchDecodePath
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
    return {
      data: new Uint8Array(data),
      width: info.width,
      height: info.height,
    }
  }

  const frameDeps = (): BenchFrameDeps => ({
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
  })

  // One motion kernel for every bench stream, as one serves every camera of a
  // node; loaded on the first decode profile. A kernel that cannot be loaded
  // is said once — the cell then records that motion did not run.
  let motion: Promise<DecodeBenchMotionPass | null> | null = null
  const motionPass = (runId: string): Promise<DecodeBenchMotionPass | null> => {
    motion ??= (async (): Promise<DecodeBenchMotionPass | null> => {
      try {
        const detector = new WasmMotionDetector()
        await detector.load()
        return (previous, current, width, height) => {
          detector.ensureSize(width, height)
          detector.detect(previous, current)
        }
      } catch (err) {
        log.warn('node bench: the motion kernel could not be loaded — decode is measured alone', {
          tags: { runId, nodeId: deps.nodeId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
        return null
      }
    })()
    return motion
  }

  return new NodeBenchHost({
    nodeId: deps.nodeId,
    loadFrames: () => loadBenchFrames(frameDeps()),
    openDecodeRig: async (profile, input) => {
      const prepared = await ensureDecodeBenchSource(
        {
          dataDir: deps.ctx().dataDir,
          ensureFfmpeg: () => deps.ctx().deps.ensureFfmpeg(),
          clipFile: () => ensureBenchClip(frameDeps()),
          runFfmpeg: runFfmpegToFile,
          log: (message, meta) => log.info(message, meta ? { meta } : undefined),
        },
        profile,
      )
      if (prepared.kind === 'skipped') return prepared
      await deps.decode.refresh()
      const rig = await openDecodeBenchRig({
        source: prepared.source,
        motionFps: input.fpsPerStream,
        fork: deps.decode.fork,
        lease: deps.decode.lease,
        hwaccel: deps.decode.hwaccel,
        logger: log,
        motion: await motionPass(input.runId),
        runId: input.runId,
        nodeId: deps.nodeId,
        admit: ramAdmission,
      })
      return { kind: 'ready', rig }
    },
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
