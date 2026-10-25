/**
 * `zone-mirror-hydration.ts` — the boot sweep that makes sure no consumer of
 * the device-state `zones` MIRROR starts blind.
 *
 * The mirror is derived state: `ZonesProvider` owns it, the durable catalogue
 * in the per-device settings store is the authority. Before this sweep the
 * mirror was written ONLY on an operator mutation, so a camera whose
 * runtime-state row had never been written had no `zones` slice at all and
 * every mirror-only consumer — the admin Zones tab, motion-wasm's zone gate,
 * the detection-pipeline zone gate — read "no zones" forever. Camera 102 sat
 * exactly like that on 2026-08-12 with a drawn 'Parking pat'.
 *
 * Why a read and not an event replay: the mirror's push channel
 * (`device.state-changed`) is telemetry and may be dropped, and a slice change
 * that was dropped is never re-sent (D8). Boot hydration therefore has to be an
 * RPC pass over the fleet, which is all this is.
 *
 * Fire-and-forget from the orchestrator bootstrap, one pass, no timers: after
 * it, `ZonesProvider.listZones` keeps the mirror reconciled for any camera
 * adopted later, and `persist` keeps it current for every mutation.
 *
 * The pass FANS OUT (D167). It was a doubled `for … await` — two hydrators ×
 * every camera, each unit a settings-store round-trip plus a `deviceState`
 * write — so the sum of the latencies WAS the wall clock: measured on the boot
 * of 2026-08-19 with 30 cameras, 455 s and 127 UDS timeouts for work in which
 * nothing is CPU-bound and no unit depends on another.
 */

import type { AddonApi, IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'

import { mapWithConcurrency } from './lane-pool.js'
import type { ZoneMirrorHydration } from './zones-provider.js'

/** How long to wait for a camera list: the hub wires `ctx.api` AFTER the addon
 *  init chain resolves, and `device-manager` answers a moment later still, so a
 *  task kicked off from `onInitialize` loses both races. Same shape as the
 *  bindings migration's poll — one budget covering "no api yet" and "api, but
 *  device-manager not answering yet", because to this sweep they are the same
 *  thing: no fleet to hydrate. */
const CAMERA_LIST_WAIT_MS = 6_000
const POLL_INTERVAL_MS = 200

/**
 * Cameras hydrated at once, per mirror.
 *
 * Each unit is two UDS round-trips (read the durable block, write the mirror
 * slice) on the SETTINGS-STORE channel — the same channel the live detection
 * path uses, which is why this is a bound and not a `Promise.all`. Four per
 * mirror, two mirrors, so at most eight requests are outstanding at any instant:
 * the same ceiling `RUNNER_SPAWN_CONCURRENCY` and `HYDRATE_DEVICE_CONCURRENCY`
 * settled on, and enough to hide the latency that made this sweep 455 s long.
 */
const HYDRATE_CAMERA_CONCURRENCY = 4

/**
 * One mirror this sweep is responsible for. There are two, and they gate
 * TOGETHER: a zone with no rule filters nothing, a rule with no zone matches
 * nothing — so hydrating one without the other still leaves both runner-side
 * zone gates inert.
 */
export interface ZoneMirrorHydrator {
  /** Slice name, for the summary line. */
  readonly mirror: string
  /** `ZonesProvider.hydrateMirror` / `ZoneRulesProvider.hydrateMirror` —
   *  reconciles ONE device's mirror against its durable authority. Reports;
   *  only throws on a bug. */
  readonly hydrate: (deviceId: number) => Promise<ZoneMirrorHydration>
}

export interface ZoneMirrorHydrationDeps {
  readonly api: () => AddonApi | null
  readonly hydrators: readonly ZoneMirrorHydrator[]
  readonly logger: IScopedLogger
  /** Test seam — how long to keep trying for the camera list before giving up. */
  readonly apiWaitMs?: number
  /** Cameras in flight per mirror. Defaults to
   *  {@link HYDRATE_CAMERA_CONCURRENCY}; tests pin the bound with it. */
  readonly concurrency?: number
}

/** What one mirror's sweep did, for its summary line. */
interface MirrorSweepTally {
  readonly written: number
  readonly unchanged: number
  readonly failed: number
}

/**
 * Hydrate the `zones` mirror for every camera once, at boot. Never throws: a
 * hydration sweep that cannot run must not take the orchestrator's boot with
 * it — but it is never silent either, because a skipped sweep is exactly the
 * failure this exists to end.
 */
export async function hydrateZoneMirrorsAtBoot(deps: ZoneMirrorHydrationDeps): Promise<void> {
  const cameraIds = await readCameraIds(deps)
  if (cameraIds === null) return

  // The two mirrors run CONCURRENTLY, and not merely for speed: they gate
  // together, so a rules sweep queued behind a zones sweep leaves both
  // runner-side gates inert for the whole duration of the first.
  await Promise.all(deps.hydrators.map((hydrator) => sweepMirror(deps, hydrator, cameraIds)))
}

/** One mirror over the whole fleet, bounded-parallel. Never throws. */
async function sweepMirror(
  deps: ZoneMirrorHydrationDeps,
  hydrator: ZoneMirrorHydrator,
  cameraIds: readonly number[],
): Promise<void> {
  const outcomes = await mapWithConcurrency(
    cameraIds,
    deps.concurrency ?? HYDRATE_CAMERA_CONCURRENCY,
    // Catching INSIDE the lane is what keeps one camera from ending the sweep —
    // the next one may be the camera whose zones an operator is waiting on.
    async (deviceId): Promise<ZoneMirrorHydration | 'threw'> => {
      try {
        return await hydrator.hydrate(deviceId)
      } catch (err: unknown) {
        deps.logger.warn('zone mirror boot hydration failed for this camera', {
          tags: { deviceId },
          meta: { mirror: hydrator.mirror, error: errMsg(err) },
        })
        return 'threw'
      }
    },
  )

  const tally = outcomes.reduce<MirrorSweepTally>(
    (acc, outcome) => ({
      written: acc.written + (outcome === 'written' ? 1 : 0),
      unchanged: acc.unchanged + (outcome === 'unchanged' ? 1 : 0),
      failed: acc.failed + (outcome === 'written' || outcome === 'unchanged' ? 0 : 1),
    }),
    { written: 0, unchanged: 0, failed: 0 },
  )

  deps.logger.info('zone mirror boot hydration complete', {
    meta: { mirror: hydrator.mirror, cameras: cameraIds.length, ...tally },
  })
}

/**
 * The camera fleet, or `null` when it never became readable inside the budget
 * — in which case this has already said so. Retried inside one budget rather
 * than once, because at orchestrator boot "no api yet" and "device-manager not
 * answering yet" are both transient and indistinguishable from here.
 */
async function readCameraIds(deps: ZoneMirrorHydrationDeps): Promise<readonly number[] | null> {
  const deadline = Date.now() + (deps.apiWaitMs ?? CAMERA_LIST_WAIT_MS)
  let lastError: unknown = null
  for (;;) {
    const api = deps.api()
    if (api) {
      try {
        const cameras = await api.deviceManager.listAll.query({
          isCamera: true,
          projection: 'slim',
        })
        return cameras.map((camera) => camera.id)
      } catch (err: unknown) {
        lastError = err
      }
    }
    if (Date.now() >= deadline) {
      // A sweep that did not run leaves every never-mutated camera's mirror
      // absent, which reads downstream as "this camera has no zones" — the
      // exact silence this module exists to end.
      deps.logger.warn(
        'zones mirror boot hydration SKIPPED — camera list never became readable; mirror-only consumers keep whatever the last write left',
        { meta: { error: lastError === null ? 'ctx.api unavailable' : errMsg(lastError) } },
      )
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}
