/**
 * face-rescore-wiring — binds the whole-archive rescore job (D866) to the real
 * stores, the cluster model pin and the orchestrator's interval setting.
 *
 * Kept out of `index.ts` (20 000 lines): the addon holds the returned runtime
 * and forwards three things to it — the two actions, the timer tick, stop.
 */
import { randomUUID } from 'node:crypto'
import { type IScopedLogger, pickFaceRescoreIntervalMinutes } from '@camstack/types'
import {
  CLUSTER_MODEL_OWNER_ADDON_ID,
  FACE_EMBEDDING_STEP_ID,
  resolveClusterModelPin,
  type ClusterModelPinApi,
} from './cluster-model-pin.js'
import type { FaceRescoreParams } from './face-rescore.js'
import { FaceRescoreJob, type FaceRescorePorts } from './face-rescore-job.js'
import { FaceRescoreScheduler } from './face-rescore-scheduler.js'
import type { FaceRescoreStatePort } from './store/face-rescore-state-store.js'
import type { FaceStore } from './store/face-store.js'
import type { IdentityStore } from './store/identity-store.js'

/** The slice of `ctx.api` the runtime reads settings through (cluster pin + interval). */
export type FaceRescoreRuntimeApi = ClusterModelPinApi

export interface FaceRescoreRuntimeDeps {
  readonly api: FaceRescoreRuntimeApi
  readonly faceStore: FaceStore
  readonly identityStore: IdentityStore
  readonly state: FaceRescoreStatePort
  readonly logger: IScopedLogger
  /** The same per-device cascade `face.rescoreTrack` scores with. */
  readonly paramsForDevice: (deviceId: number) => Promise<FaceRescoreParams>
}

export interface FaceRescoreRuntime {
  readonly job: FaceRescoreJob
  readonly scheduler: FaceRescoreScheduler
}

export function buildFaceRescoreRuntime(
  deps: FaceRescoreRuntimeDeps,
  startedAt: number,
): FaceRescoreRuntime {
  const { faceStore, identityStore, logger } = deps
  const resolveClusterModelId = (): Promise<string | null> =>
    resolveClusterModelPin(deps.api, FACE_EMBEDDING_STEP_ID, {
      warn: (m, e) => logger.warn(m, e),
    })
  const galleryManifest = (): ReturnType<FaceRescorePorts['galleryManifest']> =>
    identityStore.galleryManifest()
  const pendingMarker = (): ReturnType<FaceRescorePorts['pendingMarker']> =>
    faceStore.pendingMarker()

  const job = new FaceRescoreJob({
    resolveClusterModelId,
    galleryManifest,
    pendingMarker,
    loadGallery: () => identityStore.loadGallery(),
    identityNames: async () =>
      new Map((await identityStore.listIdentities()).map((i) => [i.id, i.name])),
    paramsForDevice: deps.paramsForDevice,
    listPendingFaceIds: () => faceStore.listPendingFaceIds(),
    loadRescoreBatch: (ids) => faceStore.loadRescoreBatch(ids),
    applySuggestionBatch: (updates) => faceStore.applySuggestionBatch(updates),
    recordCompletion: (status) =>
      deps.state.save({ fingerprint: status.fingerprint, finishedAt: Date.now(), report: status }),
    pause: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    newJobId: () => randomUUID(),
    logger,
  })

  const scheduler = new FaceRescoreScheduler(
    {
      readIntervalMinutes: async () =>
        pickFaceRescoreIntervalMinutes(
          await deps.api.addonSettings.getGlobalSettings.query({
            addonId: CLUSTER_MODEL_OWNER_ADDON_ID,
          }),
        ),
      job,
      fingerprintPorts: { resolveClusterModelId, galleryManifest, pendingMarker },
      state: deps.state,
      now: () => Date.now(),
      logger,
    },
    startedAt,
  )
  return { job, scheduler }
}
