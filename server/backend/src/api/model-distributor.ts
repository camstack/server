import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { collectModelFiles, isModelDownloaded } from '@camstack/system'
import type {
  IModelDistributorProvider,
  ModelCatalogEntry,
  ModelDistributeInput,
  ModelDistributeResult,
  ModelFormat,
} from '@camstack/types'
import type { LoggingService } from '../core/logging/logging.service'
import type { MoleculerService } from '../core/moleculer/moleculer.service'
import { buildHubHttpSource } from './addon-upload.js'
import type { ClusterBaseUrlResolver } from './hub-cluster-url.js'

const AGENT_DISTRIBUTE_TIMEOUT_MS = 60_000

function hubModelsDir(): string {
  return path.join(process.env['CAMSTACK_DATA'] ?? 'camstack-data', 'models')
}

/**
 * `tar -czf -` the given files relative to `cwd`, buffering the gzip stream.
 * Async (spawn, not execFileSync) so a large model doesn't block the event
 * loop. The agent untars this exact buffer into its own modelsDir.
 */
export function tarModelFiles(cwd: string, files: readonly string[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('tar', ['-czf', '-', '-C', cwd, ...files])
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => errChunks.push(c))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else
        reject(
          new Error(`tar exited ${code}: ${Buffer.concat(errChunks).toString().slice(0, 300)}`),
        )
    })
  })
}

/** Injectable seam — lets the orchestration be unit-tested without fs/tar/broker. */
export interface ModelDistributorSeam {
  readonly modelsDir: string
  isPresent(entry: ModelCatalogEntry, format: ModelFormat): boolean
  fileExists(rel: string): boolean
  tar(files: readonly string[]): Promise<Buffer>
  stage(buffer: Buffer): Promise<{ url: string; token: string; sha256: string; bytes: number }>
  callAgent(
    nodeId: string,
    payload: { modelId: string; format: ModelFormat; source: unknown },
  ): Promise<{ path?: string }>
}

/**
 * Core distribution logic (pure orchestration over the seam):
 * precondition-check → collect → tar → stage → trigger the agent pull.
 * `nodeId === 'hub'` is a no-op (the artifact is already resident).
 */
export async function distributeModelWith(
  seam: ModelDistributorSeam,
  input: ModelDistributeInput,
): Promise<ModelDistributeResult> {
  const { targetNodeId, modelId, format, entry } = input
  if (targetNodeId === 'hub') {
    return { ok: true, sha256: '', bytes: 0, path: seam.modelsDir }
  }
  if (!seam.isPresent(entry, format)) {
    throw new Error(`model ${modelId}/${format} not present on hub — download or convert it first`)
  }
  const files = collectModelFiles(entry, format).filter((f) => seam.fileExists(f))
  if (files.length === 0) {
    throw new Error(`model ${modelId}/${format} resolved no files to distribute`)
  }
  const tgz = await seam.tar(files)
  const source = await seam.stage(tgz)
  const res = await seam.callAgent(targetNodeId, { modelId, format, source })
  return { ok: true, sha256: source.sha256, bytes: source.bytes, path: res.path ?? '' }
}

/**
 * Build the hub-resident `model-distributor` singleton provider. Mounted as a
 * service-backed cap override in `trpc.router.ts` because it needs the
 * Moleculer broker + the deploy-stage registry, which a forked addon can't
 * reach.
 */
export function buildModelDistributorProvider(
  moleculer: MoleculerService | null,
  loggingService: LoggingService,
  /** The `local-network` cap's cluster address (`hub-cluster-url.ts`). */
  resolveClusterBaseUrl: ClusterBaseUrlResolver,
): IModelDistributorProvider {
  const logger = loggingService.createLogger('model-distributor')
  const modelsDir = hubModelsDir()
  const seam: ModelDistributorSeam = {
    modelsDir,
    isPresent: (entry, format) => isModelDownloaded(modelsDir, entry, format),
    fileExists: (rel) => fs.existsSync(path.join(modelsDir, rel)),
    tar: (files) => tarModelFiles(modelsDir, files),
    stage: async (buffer) => buildHubHttpSource(buffer, await resolveClusterBaseUrl()),
    callAgent: async (nodeId, payload) => {
      const broker = moleculer?.broker
      if (!broker) throw new Error('model-distributor: Moleculer broker unavailable')
      const raw = await broker.call('$agent.distributeModel', payload, {
        nodeID: nodeId,
        timeout: AGENT_DISTRIBUTE_TIMEOUT_MS,
      })
      return (raw ?? {}) as { path?: string }
    },
  }
  return {
    distributeModel: async (input) => {
      logger.info('Distributing model to node', {
        meta: { modelId: input.modelId, format: input.format, nodeId: input.targetNodeId },
      })
      return distributeModelWith(seam, input)
    },
  }
}
