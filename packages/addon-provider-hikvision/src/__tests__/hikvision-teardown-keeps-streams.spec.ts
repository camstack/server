/**
 * A runner that STOPS is not a camera that was REMOVED (D685).
 *
 * `removeDevice()` fires on both. `BaseDeviceProvider.onShutdown`
 * decommissions every device of a runner that is being restarted, and
 * decommission calls `removeDevice()` — so a Hikvision runner respawn used to
 * retract every stream it had published. The broker dials a Hikvision camera
 * DIRECTLY (`pull-rtsp`, the camera's own url); the provider is not on the
 * byte path at all. Retracting tore the broker and its restreamers down for
 * the ~25 s the new runner took to boot, and every consumer paid for it: each
 * recording writer on the node was refused `404` six times in a row (132 exits
 * across 11 cameras on 2026-09-29), and six of its fifteen restarts-per-hour
 * were spent on a camera that never went away.
 *
 * Real removal is the broker's own path: the device-manager emits
 * `DeviceUnregistered` and the broker's `handleDeviceRemoved` retracts the
 * whole device, assignments included.
 */
import { describe, expect, it, vi } from 'vitest'
import { HikvisionCamera } from '../hikvision-camera.js'

function makeTeardownSubject(): {
  readonly subject: object
  readonly retract: ReturnType<typeof vi.fn>
  readonly disconnectAll: ReturnType<typeof vi.fn>
} {
  const retract = vi.fn(async () => ({ success: true }))
  const disconnectAll = vi.fn(async () => undefined)
  const published = new Map([
    ['native:main', { camStreamId: 'native:main' }],
    ['native:sub', { camStreamId: 'native:sub' }],
  ])
  const subject = {
    id: 101,
    ctx: {
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      api: { streamBroker: { retractCameraStream: { mutate: retract } } },
    },
    osdPollTimer: null,
    reachabilityPoll: null,
    published,
    disconnectAll,
  }
  return { subject, retract, disconnectAll }
}

describe('HikvisionCamera.removeDevice', () => {
  it('leaves the camera streams published on the broker — a runner restart is not a removal', async () => {
    const { subject, retract, disconnectAll } = makeTeardownSubject()

    await HikvisionCamera.prototype.removeDevice.call(subject)

    // The provider's own resources are still released…
    expect(disconnectAll).toHaveBeenCalledTimes(1)
    // …but the broker keeps dialling the camera it never needed us for.
    expect(retract).not.toHaveBeenCalled()
  })
})
