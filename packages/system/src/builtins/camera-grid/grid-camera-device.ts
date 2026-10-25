/**
 * The composite camera device.
 *
 * An ORDINARY camera in every respect the rest of the system can see: it
 * records, it appears in the timeline, it has profile slots, it is bound like
 * any other. What makes it a grid is invisible from here — its streams are
 * composed rather than dialled, and object detection is switched off at
 * CREATION (see `silence-analysis.ts`), never re-asserted.
 *
 * ## The three native caps, and why each is native
 *
 * - **`stream-catalog`** — what this grid OFFERS, one descriptor per profile it
 *   can honestly compose. Named on every pull, idle included: the broker sweeps
 *   anything its registry holds that a catalog does not name.
 * - **`camera-grid-layout`** — the geometry, on the camera's own page. Device
 *   scoped so the widget asks THE CAMERA; the addon-scoped custom actions it
 *   replaces could only be reached by a caller that already knew the addon id,
 *   which is why the editor rendered nowhere.
 * - **`snapshot`** — a frame of the composition. It used to be deliberately
 *   ABSENT, on the reasoning that the broker's ordinary grab takes one from the
 *   profile slot and taking one IS a consumer. That is true and it is the
 *   defect: it means a thumbnail in a list starts N decodes, and on a battery
 *   source it would be a wake. A native provider runs BEFORE that grab and
 *   answers from the live composition or from the frame it kept
 *   (`grid-snapshot.ts`).
 */
import {
  BaseDevice,
  cameraGridLayoutCapability,
  type CamStreamDescriptor,
  type DeviceContext,
  DeviceFeature,
  type GridLayoutPatch,
  type GridLayoutView,
  type InferNativeProvider,
  motionCapability,
  type MotionStatus,
  snapshotCapability,
  streamCatalogCapability,
} from '@camstack/types'
import { z } from 'zod'
import { buildGridLayoutNativeProvider } from './grid-layout-native-provider.js'
import type { GridSnapshotImage } from './grid-snapshot.js'

const gridCameraSchema: z.ZodObject<{ instanceId: z.ZodString }> = z.object({
  /** The persisted grid row this camera was declared from. */
  instanceId: z.string().min(1),
})

/**
 * What the device needs from the running addon. Installed as a module
 * singleton, like the Terminal camera's relay: `DeclaredDevices` constructs
 * devices, so a device cannot be handed a constructor dependency.
 */
export interface GridCameraRuntime {
  /**
   * The catalog descriptors for this grid — one per OFFERED profile — or `null`
   * when the addon cannot say. `null` is a REFUSAL to describe, never an empty
   * catalog with a shrug: see the note on the empty branch below.
   */
  descriptorsFor(instanceId: string): readonly CamStreamDescriptor[] | null
  /** The grid behind a device, or `null` — which means "answered: not a grid". */
  getLayout(deviceId: number): GridLayoutView | null
  saveLayout(patch: GridLayoutPatch): Promise<GridLayoutView>
  /** A frame of the composition, or `null`. Never starts one. */
  getSnapshot(deviceId: number): Promise<GridSnapshotImage | null>
  /**
   * This grid's own motion, derived from its sources (`grid-activity-mirror`).
   *
   * The device answers `motion.getStatus` from it because the VIEWER polls that
   * as its backstop — it subscribes to `motion.on-motion-changed` and polls the
   * status in case an event was missed. A grid that emitted the event but could
   * not answer the poll would light up and then, on any dropped edge, be
   * unrecoverably dark until the next one.
   */
  motionStatus(deviceId: number): MotionStatus
}

let runtime: GridCameraRuntime | null = null

export function installGridCameraRuntime(next: GridCameraRuntime | null): void {
  runtime = next
}

function activeRuntime(): GridCameraRuntime {
  if (runtime === null) throw new Error('camera-grid: the addon runtime is not installed')
  return runtime
}

export class GridCameraDevice extends BaseDevice<typeof gridCameraSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.NativeSnapshot]

  constructor(ctx: DeviceContext) {
    super(ctx, gridCameraSchema, { type: ctx.deviceMeta.type })

    const catalogProvider: InferNativeProvider<typeof streamCatalogCapability> = {
      getCatalog: async ({ deviceId }) => {
        if (deviceId !== this.id) return []
        return this.catalog()
      },
    }
    this.ctx.registerNativeCap(streamCatalogCapability, catalogProvider)

    // The whole provider — the layout AND the section that renders it — comes
    // from one place, because a contribution call carries a `deviceId` and is
    // therefore answered by THIS provider or by nothing
    // (`grid-layout-native-provider.ts`).
    const layoutProvider = buildGridLayoutNativeProvider({
      getLayout: (deviceId) => activeRuntime().getLayout(deviceId),
      saveLayout: (patch) => activeRuntime().saveLayout(patch),
    })
    this.ctx.registerNativeCap(cameraGridLayoutCapability, layoutProvider)

    const snapshotProvider: InferNativeProvider<typeof snapshotCapability> = {
      getSnapshot: async ({ deviceId }) => activeRuntime().getSnapshot(deviceId),
      invalidateCache: async () => {
        // The snapshot wrapper owns its cache. There is nothing to invalidate
        // here: the only frame this provider holds is the one it kept for the
        // hours nobody is watching, and throwing that away would leave the
        // grid with the courtesy card and no way to get a better answer.
      },
    }
    this.ctx.registerNativeCap(snapshotCapability, snapshotProvider)

    // A grid is a camera, so it answers a camera's questions. Its motion is
    // the OR of its sources' — the addon keeps that; this is only the read.
    const motionProvider: InferNativeProvider<typeof motionCapability> = {
      getStatus: async ({ deviceId }) => activeRuntime().motionStatus(deviceId),
      isDetected: async ({ deviceId }) => activeRuntime().motionStatus(deviceId).detected,
    }
    this.ctx.registerNativeCap(motionCapability, motionProvider)

    this.markOnline(true)
  }

  private catalog(): readonly CamStreamDescriptor[] {
    // Answering `[]` would let the broker's catalog reconcile read "this camera
    // offers nothing" and retract every stream — a restart, or one unreadable
    // profile-slot list, would take the grid's slots with it. A refusal is an
    // error, and an error is not an empty catalog.
    const descriptors = activeRuntime().descriptorsFor(this.config.get('instanceId'))
    if (descriptors === null) {
      throw new Error(
        `camera-grid: cannot describe the streams of instance ${this.config.get('instanceId')}`,
      )
    }
    // ALWAYS named, including while the composition is idle. The catalog says
    // what the grid OFFERS, not what is currently running — a catalog that went
    // empty when nobody was watching would make the broker sweep the stream of
    // every idle grid, which is all of them by design.
    return descriptors
  }

  setAddonOnline(online: boolean): void {
    this.markOnline(online)
  }
}
