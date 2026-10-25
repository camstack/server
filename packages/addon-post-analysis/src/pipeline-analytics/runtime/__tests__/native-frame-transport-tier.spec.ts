/**
 * `getNativeCropJpeg` tier gate.
 *
 * The subject-crop fetch (`crop` / `thumbnail` / `faceCrop` / `plateCrop`) is
 * NATIVE-OR-NOTHING — the contract is written in `pipeline-runner.cap.ts`:
 * `ram-fullframe` is "legit for the blank-frame guard / 640-snapshot resolve,
 * NOT for the clean keyFrame". The by-handle keyFrame path applied it (that
 * path and its predicate are gone since D422/D680, so this spec is now the
 * only one pinning the rule); this path did not, and it is reachable: the runner
 * classifies a request as full-frame from its BBOX
 * (`x<=.001 && y<=.001 && w>=.999 && h>=.999`), and the 16:9 thumbnail window
 * of a large subject legitimately covers the whole raster. Such a request skips
 * the native lease entirely and is served from the ≤640 RAM store — a stored
 * best-shot pinned at detection resolution, indistinguishable from a native one
 * unless the tier is read.
 */
import { describe, expect, it } from 'vitest'
import type { AddonContext, FrameHandle, IScopedLogger } from '@camstack/types'
import { createNativeFrameTransport } from '../native-frame-transport.js'

interface LoggedEntry {
  readonly level: string
  readonly message: string
  readonly extras: unknown
}

function stubLogger(entries: LoggedEntry[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: (message, extras) => entries.push({ level: 'debug', message, extras }),
    info: (message, extras) => entries.push({ level: 'info', message, extras }),
    warn: (message, extras) => entries.push({ level: 'warn', message, extras }),
    error: (message, extras) => entries.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const HANDLE: FrameHandle = {
  shmId: 'shm-1',
  slot: 0,
  seq: 2,
  width: 640,
  height: 360,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 360 * 3,
  nodeId: 'hub',
  slotCount: 4,
}

/** A 4x4 rgb24 raster — the smallest thing sharp will encode. */
const RGB_4X4 = Buffer.alloc(4 * 4 * 3, 120)

interface Harness {
  readonly getNativeCropJpeg: (
    handle: FrameHandle,
    bbox: { x: number; y: number; w: number; h: number },
    maxWidth?: number,
    deviceId?: number,
  ) => Promise<Buffer | null>
  readonly entries: readonly LoggedEntry[]
}

function harness(tier: 'native' | 'ram-fullframe' | undefined): Harness {
  const entries: LoggedEntry[] = []
  const api = {
    pipelineRunner: {
      getNativeCrop: {
        query: async () => ({
          bytes: RGB_4X4,
          width: 4,
          height: 4,
          ...(tier !== undefined ? { tier } : {}),
        }),
      },
    },
  } as unknown as AddonContext['api']
  const transport = createNativeFrameTransport({
    api,
    ownNodeId: 'hub',
    logger: stubLogger(entries),
  })
  return { getNativeCropJpeg: transport.getNativeCropJpeg, entries }
}

const FULL_FRAME_WINDOW = { x: 0, y: 0, w: 1, h: 1 }

describe('getNativeCropJpeg — tier gate', () => {
  it('serves a NATIVE-tier crop', async () => {
    const h = harness('native')
    const jpeg = await h.getNativeCropJpeg(HANDLE, FULL_FRAME_WINDOW, undefined, 102)
    expect(jpeg).not.toBeNull()
  })

  it('REFUSES a ram-fullframe crop — a best shot is never a ≤640 raster', async () => {
    const h = harness('ram-fullframe')
    const jpeg = await h.getNativeCropJpeg(HANDLE, FULL_FRAME_WINDOW, undefined, 102)
    expect(jpeg).toBeNull()
  })

  it('names the refusal out loud, per camera', async () => {
    const h = harness('ram-fullframe')
    await h.getNativeCropJpeg(HANDLE, FULL_FRAME_WINDOW, undefined, 102)
    const line = h.entries.find((e) => e.message.includes('sub-native tier'))
    expect(line).toBeDefined()
    expect(line?.level).toBe('info')
    expect(line?.extras).toMatchObject({ tags: { deviceId: 102 } })
  })

  it('ACCEPTS an absent tier — a pre-tier runner keeps working (mixed-version cluster)', async () => {
    const h = harness(undefined)
    const jpeg = await h.getNativeCropJpeg(HANDLE, FULL_FRAME_WINDOW, undefined, 102)
    expect(jpeg).not.toBeNull()
  })
})
