/**
 * The channel gate: what it costs disarmed, and what it promises armed.
 *
 * The load-bearing test here is `costs one boolean read while disarmed`. It
 * proves two things at once and both are structural:
 *
 *  - `on` is a plain data property with no getter, so `if (CH.on && …)`
 *    compiles to a load and a branch;
 *  - `wants()` returns before touching the device set, pinned by redefining
 *    that field as a THROWING accessor. The moment the guard moves below any
 *    field access, this spec fails instead of the process silently paying for
 *    a channel nobody armed.
 *
 * It is the same discipline `logging-gate.spec.ts` uses for the destination
 * floor, whose disarmed cost was measured at 1.93 ns/call. Extended here
 * rather than re-invented, because the two gates are read on the same line.
 *
 * Neutralisations checked and reported — see each test.
 */

import { describe, expect, it } from 'vitest'
import type { IScopedLogger, LogExtras } from '../../interfaces/logging.js'
import { LogChannelGate, LogChannelRegistry, type LogChannelDescriptor } from '../log-channel.js'

const PER_DEVICE: LogChannelDescriptor = {
  name: 'stream-broker.webrtc',
  description: 'x',
  defaultLevel: 'info',
  perDevice: true,
}

const CLUSTER_WIDE: LogChannelDescriptor = {
  name: 'stream-broker.rtp',
  description: 'y',
  defaultLevel: 'info',
  perDevice: false,
}

interface Line {
  readonly level: string
  readonly message: string
  readonly extras: LogExtras | undefined
}

function spyLogger(lines: Line[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: (m, e) => {
      lines.push({ level: 'debug', message: m, extras: e })
    },
    info: (m, e) => {
      lines.push({ level: 'info', message: m, extras: e })
    },
    warn: (m, e) => {
      lines.push({ level: 'warn', message: m, extras: e })
    },
    error: (m, e) => {
      lines.push({ level: 'error', message: m, extras: e })
    },
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

describe('LogChannelGate — the disarmed cost', () => {
  /**
   * Neutralisation: change `wants()` to
   * `return this.devices === null || this.devices.has(deviceId)` with the
   * `if (!this.on)` guard removed, and this test throws. Confirmed 2026-08-27.
   */
  it('costs one boolean read while disarmed — no other property is touched', () => {
    const gate = new LogChannelGate(PER_DEVICE)

    const descriptor = Object.getOwnPropertyDescriptor(gate, 'on')
    // A FIELD, never an accessor: `if (CH.on && …)` must be a load, not a call.
    expect(descriptor?.get).toBeUndefined()
    expect(descriptor?.value).toBe(false)

    // Punish any read of the device set while the channel is disarmed.
    Object.defineProperty(gate, 'devices', {
      get() {
        throw new Error('device set read while the channel was disarmed')
      },
      configurable: true,
    })

    expect(gate.wants(102)).toBe(false)
    expect(gate.armedUntilMs).toBe(0)
  })

  it('writes nothing while disarmed', () => {
    const lines: Line[] = []
    const gate = new LogChannelGate(PER_DEVICE)

    gate.log(spyLogger(lines), 'never', { tags: { deviceId: 102 } })

    expect(lines).toHaveLength(0)
  })
})

describe('LogChannelGate — armed', () => {
  /**
   * Neutralisation: emit at `logger.debug` instead and this fails. Confirmed
   * 2026-08-27. It matters because Loki drops below `info`, so a `debug` line
   * is a diagnostic that does not exist an hour later.
   */
  it('emits at the declared level and never at debug', () => {
    const lines: Line[] = []
    const gate = new LogChannelGate(PER_DEVICE)
    gate.arm({ channel: PER_DEVICE.name, armedUntilMs: 10_000, deviceIds: null })

    gate.log(spyLogger(lines), 'a line', { tags: { deviceId: 102 } })

    expect(lines.map((l) => l.level)).toEqual(['info'])
  })

  it('tags the line with logChannel — never `channel`, which already means the NVR sub-channel', () => {
    const lines: Line[] = []
    const gate = new LogChannelGate(PER_DEVICE)
    gate.arm({ channel: PER_DEVICE.name, armedUntilMs: 10_000, deviceIds: null })

    gate.log(spyLogger(lines), 'a line', { tags: { deviceId: 102 }, meta: { k: 1 } })

    expect(lines[0]?.extras?.tags).toMatchObject({
      logChannel: 'stream-broker.webrtc',
      deviceId: 102,
    })
    expect(lines[0]?.extras?.meta).toEqual({ k: 1 })
  })

  /**
   * The per-camera scope, which is the whole reason the repo's
   * `tags: { deviceId }` rule was worth its cost.
   *
   * Neutralisation: make `arm` ignore `deviceIds` (always `this.devices =
   * null`) and the 101 expectation fails. Confirmed 2026-08-27.
   */
  it('narrows to the named cameras — 101 does not pass when the window says 102', () => {
    const gate = new LogChannelGate(PER_DEVICE)
    gate.arm({ channel: PER_DEVICE.name, armedUntilMs: 10_000, deviceIds: [102] })

    expect(gate.wants(102)).toBe(true)
    expect(gate.wants(101)).toBe(false)
  })

  it('treats an EMPTY device list as every camera, never as no camera', () => {
    // A window matching nothing is indistinguishable from a disarmed one, and
    // the operator who asked for it would wait for lines that cannot come.
    const gate = new LogChannelGate(PER_DEVICE)
    gate.arm({ channel: PER_DEVICE.name, armedUntilMs: 10_000, deviceIds: [] })

    expect(gate.wants(102)).toBe(true)
    expect(gate.wants(101)).toBe(true)
  })

  it('re-arming RESTARTS rather than accumulating', () => {
    const gate = new LogChannelGate(PER_DEVICE)
    gate.arm({ channel: PER_DEVICE.name, armedUntilMs: 10_000, deviceIds: [102] })
    gate.arm({ channel: PER_DEVICE.name, armedUntilMs: 20_000, deviceIds: [101] })

    expect(gate.wants(102)).toBe(false)
    expect(gate.wants(101)).toBe(true)
    expect(gate.armedUntilMs).toBe(20_000)
  })
})

describe('LogChannelRegistry', () => {
  it('refuses a duplicate name instead of merging', () => {
    const registry = new LogChannelRegistry()
    registry.declare(PER_DEVICE)

    expect(() => registry.declare({ ...PER_DEVICE, description: 'other' })).toThrow(
      /already declared/,
    )
  })

  it('refuses a name that is not dotted lower-kebab', () => {
    const registry = new LogChannelRegistry()

    expect(() => registry.declare({ ...PER_DEVICE, name: 'StreamBroker' })).toThrow()
  })

  /**
   * `apply` is FULL, not incremental: a channel the document does not name is
   * disarmed. An incremental apply would let a disarm get lost in transit and
   * leave a channel running that nobody can see is running.
   *
   * Neutralisation: skip the `gate.disarm()` branch in `apply` and this fails.
   * Confirmed 2026-08-27.
   */
  it('disarms a channel the applied set does not name', () => {
    const registry = new LogChannelRegistry()
    const webrtc = registry.declare(PER_DEVICE)
    const rtp = registry.declare(CLUSTER_WIDE)

    registry.apply(
      [
        { channel: PER_DEVICE.name, armedUntilMs: 10_000, deviceIds: null },
        { channel: CLUSTER_WIDE.name, armedUntilMs: 10_000, deviceIds: null },
      ],
      1_000,
    )
    expect(webrtc.on).toBe(true)
    expect(rtp.on).toBe(true)

    registry.apply([{ channel: PER_DEVICE.name, armedUntilMs: 10_000, deviceIds: null }], 1_000)
    expect(webrtc.on).toBe(true)
    expect(rtp.on).toBe(false)
  })

  it('ignores an already-expired window instead of arming it', () => {
    // A restore that re-armed an expired window would make a forgotten
    // diagnostic immortal across restarts — the one failure a deadline exists
    // to prevent.
    const registry = new LogChannelRegistry()
    const gate = registry.declare(PER_DEVICE)

    registry.apply([{ channel: PER_DEVICE.name, armedUntilMs: 500, deviceIds: null }], 1_000)

    expect(gate.on).toBe(false)
  })

  it('reports a channel this process does not declare rather than swallowing it', () => {
    const registry = new LogChannelRegistry()
    registry.declare(PER_DEVICE)

    const unknown = registry.apply(
      [{ channel: 'somebody-else.thing', armedUntilMs: 10_000, deviceIds: null }],
      1_000,
    )

    expect(unknown).toEqual(['somebody-else.thing'])
  })

  it('tick() closes what has run out and names it once', () => {
    const registry = new LogChannelRegistry()
    const gate = registry.declare(PER_DEVICE)
    registry.apply([{ channel: PER_DEVICE.name, armedUntilMs: 5_000, deviceIds: null }], 1_000)

    expect(registry.tick(4_000)).toEqual([])
    expect(gate.on).toBe(true)

    expect(registry.tick(5_000)).toEqual([PER_DEVICE.name])
    expect(gate.on).toBe(false)
    // Closed once, not on every tick after.
    expect(registry.tick(9_000)).toEqual([])
  })

  it('lists declarations sorted, so the operator sees a stable roster', () => {
    const registry = new LogChannelRegistry()
    registry.declare(CLUSTER_WIDE)
    registry.declare(PER_DEVICE)

    expect(registry.list().map((d) => d.name)).toEqual([
      'stream-broker.rtp',
      'stream-broker.webrtc',
    ])
  })
})
