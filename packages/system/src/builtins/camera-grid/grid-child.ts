/**
 * Spawning the composition, through the ONE primitive.
 *
 * `FfmpegProcess` (`@camstack/types`) owns spawn, the first-data deadline, the
 * hardware→software retry, exit classification and the bounded restart. This
 * file owns only the PLUMBING — which bytes go where — because that is the one
 * thing the primitive deliberately does not own.
 *
 * `maxRestarts: 0`. A composite is demand-driven: if the child dies, the
 * session tells every consumer why and tears down, and the consumer's next read
 * starts a cold one with freshly acquired sources. A restart inside the process
 * would reuse broker handles that may already have been released.
 */
import { buildFfmpegArgs, type IScopedLogger } from '@camstack/types'
import { FfmpegProcess } from '@camstack/types/node'
import { gridStreamInvocation } from './grid-stream-invocation.js'
import type { GridSourceHandle, GridStreamChild, GridStreamPlan } from './grid-stream-session.js'

export interface GridChildContext {
  readonly binaryPath: string
  readonly logger: IScopedLogger
  /** The COMPOSITE's device id — every line the primitive emits is tagged with it. */
  readonly deviceId: number
  /**
   * The SOURCE cameras' names, for the cards the canvas is seeded with
   * (`grid-canvas-seed.ts`). Read at the point of use rather than mirrored:
   * this addon does not own those devices, and a name it cached would be the
   * second copy of a fact the device manager already owns (D224).
   *
   * Optional, and a failure is not one: a card with no name carries the device
   * id, which is what every log line about that tile carries anyway.
   */
  readonly resolveSourceNames?: (
    deviceIds: readonly number[],
  ) => Promise<ReadonlyMap<number, string>>
}

/** No first-data deadline retry loop: one attempt, and the session hears about it. */
const FIRST_DATA_TIMEOUT_MS = 15_000

export async function startGridChild(
  ctx: GridChildContext,
  plan: GridStreamPlan,
  sources: readonly GridSourceHandle[],
  onEnded: (reason: string) => void,
): Promise<GridStreamChild> {
  const invocation = (decodeHwAccel: string | null) =>
    gridStreamInvocation({
      layout: plan.layout,
      sources: plan.sourceDeviceIds.map((deviceId, index) => ({
        deviceId,
        url: sources[index]?.url ?? '',
      })),
      decodeHwAccel,
      encoder: plan.encoder,
      fps: plan.fps,
      bitrateKbps: plan.bitrateKbps,
    })

  let stdout: GridStreamChild['stdout'] | null = null
  const process = new FfmpegProcess({
    binaryPath: ctx.binaryPath,
    buildArgs: (decodeHwAccel) => buildFfmpegArgs(invocation(decodeHwAccel)),
    decodeHwAccel: plan.decodeHwAccel,
    logger: ctx.logger,
    deviceId: ctx.deviceId,
    role: 'camera-grid',
    tags: { cells: plan.layout.cells.length, inputs: plan.sourceDeviceIds.length },
    firstDataTimeoutMs: FIRST_DATA_TIMEOUT_MS,
    maxRestarts: 0,
    onChild: (child) => {
      if (child.stdout) stdout = child.stdout
      child.stderr?.on('data', () => {
        // The primitive already keeps the stderr tail and reports it on exit.
        // Draining it here is what stops a full pipe buffer freezing ffmpeg.
      })
    },
    onExit: (exit) => {
      onEnded(exit.classification)
    },
  })

  await process.start()
  if (stdout === null) {
    await process.stop()
    throw new Error('camera-grid: the composition child produced no stdout to read')
  }

  return {
    stdout,
    stop: async () => {
      await process.stop()
    },
  }
}
