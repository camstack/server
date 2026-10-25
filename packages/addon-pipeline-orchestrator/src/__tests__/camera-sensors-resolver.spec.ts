/**
 * Resolving a camera's attached sensors (D672) from stable refs to device
 * ids, OFF the event path. D49: a failed read changes nothing, and un-routing
 * a ready ref needs two agreeing by-id reads plus a by-addon listing that
 * also does not find it.
 */
import type { CameraSensorsConfig, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type CameraSensorDeviceRow,
  type CameraSensorsResolverPorts,
  type DeviceRowsRead,
  resolveCameraSensors,
  type SourceCapsRead,
} from '../camera-sensors/resolver.js'
import type { CameraSensorsSetting } from '../camera-sensors/settings.js'

const CAM = 103
const PIR_REF = { addonId: 'provider-homeassistant', stableId: 'ha:porch-pir' }
const PIR_ROW: CameraSensorDeviceRow = {
  id: 3299,
  ...PIR_REF,
  name: 'Motion',
  online: true,
  disabled: false,
  isCamera: false,
}
const configured = (sensors = [PIR_REF]): CameraSensorsSetting => ({
  state: 'configured',
  config: { sensors: sensors.map((ref) => ({ ...ref, mode: 'in-addition' as const })) },
})

interface FakeInit {
  readonly rows: readonly CameraSensorDeviceRow[]
  readonly caps: ReadonlyMap<number, readonly string[]>
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this
    }),
    withTags: vi.fn(function (this: unknown) {
      return this
    }),
  }
}

function ports(init: FakeInit) {
  let rows = init.rows
  let caps = init.caps
  let listByIdsError: string | null = null
  let listByAddonError: string | null = null
  let capsError: string | null = null
  // One-shot answers for the next by-id reads: rows, or an error string.
  const onceByIds: (readonly CameraSensorDeviceRow[] | string)[] = []
  const logger = makeLogger()
  const listByIds = vi.fn(async (ids: readonly number[]): Promise<DeviceRowsRead> => {
    if (listByIdsError !== null) return { kind: 'unreadable', error: listByIdsError }
    const answer = onceByIds.shift() ?? rows
    if (typeof answer === 'string') return { kind: 'unreadable', error: answer }
    return { kind: 'rows', rows: answer.filter((r) => ids.includes(r.id)) }
  })
  const listByAddon = vi.fn(async (addonId: string): Promise<DeviceRowsRead> => {
    if (listByAddonError !== null) return { kind: 'unreadable', error: listByAddonError }
    return { kind: 'rows', rows: rows.filter((r) => r.addonId === addonId) }
  })
  const sourceCapsOf = vi.fn(async (ids: readonly number[]): Promise<SourceCapsRead> => {
    if (capsError !== null) return { kind: 'unreadable', error: capsError }
    return { kind: 'caps', byDevice: new Map([...caps].filter(([id]) => ids.includes(id))) }
  })
  // A test double for the scoped logger — only `warn` is asserted.
  const scoped = logger as unknown as IScopedLogger
  const value: CameraSensorsResolverPorts = { logger: scoped, listByAddon, listByIds, sourceCapsOf }
  return {
    ...value,
    listByIds,
    listByAddon,
    sourceCapsOf,
    warn: logger.warn,
    setRows(next: readonly CameraSensorDeviceRow[]) {
      rows = next
    },
    setCaps(next: ReadonlyMap<number, readonly string[]>) {
      caps = next
    },
    failListByIds(error: string | null) {
      listByIdsError = error
    },
    failListByAddon(error: string | null) {
      listByAddonError = error
    },
    failSourceCaps(error: string | null) {
      capsError = error
    },
    answerListByIdsOnce(answer: readonly CameraSensorDeviceRow[]) {
      onceByIds.push(answer)
    },
    failListByIdsOnce(error: string) {
      onceByIds.push(error)
    },
  }
}

describe('resolveCameraSensors (D672)', () => {
  it('resolves a stable ref to its device, ready with its source caps', async () => {
    const p = ports({ rows: [PIR_ROW], caps: new Map([[3299, ['motion']]]) })
    const r = await resolveCameraSensors(CAM, configured(), null, p)
    expect(r.inputs).toEqual([
      {
        ref: { ...PIR_REF, mode: 'in-addition' },
        deviceId: 3299,
        mode: 'in-addition',
        ready: true,
      },
    ])
    expect(r.status).toEqual({
      state: 'configured',
      cameraMotion: 'always',
      sensors: [
        {
          ...PIR_REF,
          mode: 'in-addition',
          state: 'ready',
          deviceId: 3299,
          name: 'Motion',
          caps: ['motion'],
        },
      ],
    })
    expect(p.listByAddon).toHaveBeenCalledTimes(1)
    expect(p.listByIds).toHaveBeenCalledTimes(0)
  })

  it('names a missing ref and routes nothing', async () => {
    const p = ports({ rows: [], caps: new Map() })
    const r = await resolveCameraSensors(CAM, configured(), null, p)
    expect(r.inputs).toEqual([])
    expect(r.status).toEqual({
      state: 'configured',
      cameraMotion: 'always',
      sensors: [
        {
          ...PIR_REF,
          mode: 'in-addition',
          state: 'missing',
          reason: 'no device provider-homeassistant/ha:porch-pir',
        },
      ],
    })
  })

  it('an offline sensor stays routed and is named offline', async () => {
    const p = ports({ rows: [{ ...PIR_ROW, online: false }], caps: new Map([[3299, ['motion']]]) })
    const r = await resolveCameraSensors(CAM, configured(), null, p)
    expect(r.inputs).toEqual([
      {
        ref: { ...PIR_REF, mode: 'in-addition' },
        deviceId: 3299,
        mode: 'in-addition',
        ready: false,
      },
    ])
    expect(r.status).toMatchObject({
      sensors: [{ state: 'offline', reason: 'offline', deviceId: 3299, name: 'Motion' }],
    })
  })

  it('a disabled sensor stays routed and is named disabled', async () => {
    const p = ports({ rows: [{ ...PIR_ROW, disabled: true }], caps: new Map([[3299, ['motion']]]) })
    const r = await resolveCameraSensors(CAM, configured(), null, p)
    expect(r.inputs).toEqual([
      {
        ref: { ...PIR_REF, mode: 'in-addition' },
        deviceId: 3299,
        mode: 'in-addition',
        ready: false,
      },
    ])
    expect(r.status).toMatchObject({ sensors: [{ state: 'offline', reason: 'disabled' }] })
  })

  it('a camera is refused as a sensor', async () => {
    const p = ports({ rows: [{ ...PIR_ROW, isCamera: true }], caps: new Map([[3299, ['motion']]]) })
    const r = await resolveCameraSensors(CAM, configured(), null, p)
    expect(r.inputs).toEqual([])
    expect(r.status).toMatchObject({
      sensors: [
        { state: 'unsupported', deviceId: 3299, reason: 'a camera cannot be a camera sensor' },
      ],
    })
  })

  it('a device with no source cap is unsupported, not ready', async () => {
    const p = ports({ rows: [PIR_ROW], caps: new Map([[3299, []]]) })
    const r = await resolveCameraSensors(CAM, configured(), null, p)
    expect(r.inputs).toEqual([])
    expect(r.status).toMatchObject({
      sensors: [{ state: 'unsupported', deviceId: 3299, name: 'Motion' }],
    })
    const [sensor] = r.status.state === 'configured' ? r.status.sensors : []
    expect(sensor?.state === 'unsupported' ? sensor.reason : '').toMatch(
      /^no motion-capable cap bound \(supported: .*motion.*\)$/,
    )
  })

  it('unreadable bindings keep the sensor routed and say so', async () => {
    const p = ports({ rows: [PIR_ROW], caps: new Map([[3299, ['motion']]]) })
    p.failSourceCaps('bindings timeout')
    const r = await resolveCameraSensors(CAM, configured(), null, p)
    expect(r.inputs).toEqual([
      {
        ref: { ...PIR_REF, mode: 'in-addition' },
        deviceId: 3299,
        mode: 'in-addition',
        ready: false,
      },
    ])
    expect(r.status).toMatchObject({
      sensors: [{ state: 'unreadable', reason: 'bindings unreadable — bindings timeout' }],
    })
    expect(p.warn).toHaveBeenCalledTimes(1)
    expect(p.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: { deviceId: CAM },
        meta: { read: 'sourceCapsOf', error: 'bindings timeout' },
      }),
    )
  })

  it('a failed lookup keeps the ready mapping and says unreadable (D49)', async () => {
    const p = ports({ rows: [PIR_ROW], caps: new Map([[3299, ['motion']]]) })
    const ready = await resolveCameraSensors(CAM, configured(), null, p)
    p.failListByIds('store timeout')
    const failed = await resolveCameraSensors(CAM, configured(), ready, p)
    expect(failed.inputs).toEqual(ready.inputs)
    expect(failed.status).toMatchObject({
      state: 'configured',
      cameraMotion: 'always',
      sensors: [{ state: 'unreadable', reason: 'device lookup failed — store timeout' }],
    })
    expect(p.warn).toHaveBeenCalledTimes(1)
    expect(p.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: { deviceId: CAM },
        meta: { read: 'listByIds', error: 'store timeout' },
      }),
    )
  })

  it('a failed lookup never un-routes, even where a listing would not find the device', async () => {
    const p = ports({ rows: [PIR_ROW], caps: new Map([[3299, ['motion']]]) })
    const ready = await resolveCameraSensors(CAM, configured(), null, p)
    p.failListByIds('store timeout')
    p.setRows([])
    const failed = await resolveCameraSensors(CAM, configured(), ready, p)
    expect(failed.inputs).toEqual([
      {
        ref: { ...PIR_REF, mode: 'in-addition' },
        deviceId: 3299,
        mode: 'in-addition',
        ready: true,
      },
    ])
    expect(p.listByAddon).toHaveBeenCalledTimes(1) // only the first, unfailed pass listed the addon
  })

  it('a failed second lookup keeps the mapping, awaiting confirmation', async () => {
    const p = ports({ rows: [PIR_ROW], caps: new Map([[3299, ['motion']]]) })
    const ready = await resolveCameraSensors(CAM, configured(), null, p)
    p.answerListByIdsOnce([]) // first by-id read says gone
    p.failListByIdsOnce('store timeout') // the confirming read fails
    const r = await resolveCameraSensors(CAM, configured(), ready, p)
    expect(r.inputs).toEqual(ready.inputs)
    expect(r.status).toMatchObject({
      sensors: [
        {
          state: 'unreadable',
          reason: 'awaiting confirmation — second lookup failed: store timeout',
        },
      ],
    })
  })

  it('one contradicting answer does not un-route; two agreeing answers plus an empty addon listing do', async () => {
    const p = ports({ rows: [PIR_ROW], caps: new Map([[3299, ['motion']]]) })
    const ready = await resolveCameraSensors(CAM, configured(), null, p)
    p.answerListByIdsOnce([]) // first by-id read says gone, second still finds it
    const flicker = await resolveCameraSensors(CAM, configured(), ready, p)
    expect(flicker.inputs).toEqual(ready.inputs)
    expect(flicker.status).toEqual(ready.status)
    p.setRows([]) // really gone
    const gone = await resolveCameraSensors(CAM, configured(), ready, p)
    expect(gone.inputs).toEqual([])
    expect(gone.status).toMatchObject({ sensors: [{ state: 'missing' }] })
    expect(p.listByIds).toHaveBeenCalledTimes(4) // 2 on the flicker pass (miss, then found) + 2 on the gone pass (miss, miss)
  })

  it('a confirmed-gone ref whose addon listing FAILS keeps its routing, unreadable (R10, D49)', async () => {
    const p = ports({ rows: [PIR_ROW], caps: new Map([[3299, ['motion']]]) })
    const ready = await resolveCameraSensors(CAM, configured(), null, p)
    p.setRows([])
    p.failListByAddon('provider offline')
    const r = await resolveCameraSensors(CAM, configured(), ready, p)
    expect(r.inputs).toEqual([
      {
        ref: { ...PIR_REF, mode: 'in-addition' },
        deviceId: 3299,
        mode: 'in-addition',
        ready: true,
      },
    ])
    expect(r.status).toMatchObject({
      sensors: [
        {
          state: 'unreadable',
          reason: 'device listing of provider-homeassistant failed — provider offline',
        },
      ],
    })
  })

  it('a never-resolved ref whose addon listing fails routes nothing and says unreadable', async () => {
    const p = ports({ rows: [PIR_ROW], caps: new Map([[3299, ['motion']]]) })
    p.failListByAddon('provider offline')
    const r = await resolveCameraSensors(CAM, configured(), null, p)
    expect(r.inputs).toEqual([])
    expect(r.status).toMatchObject({
      sensors: [
        {
          state: 'unreadable',
          reason: 'device listing of provider-homeassistant failed — provider offline',
        },
      ],
    })
  })

  it('an unreadable setting keeps the mapping; a positive removal clears it', async () => {
    const p = ports({ rows: [PIR_ROW], caps: new Map([[3299, ['motion']]]) })
    const ready = await resolveCameraSensors(CAM, configured(), null, p)
    const unreadable = await resolveCameraSensors(
      CAM,
      { state: 'unreadable', reason: 'settings read failed — store timeout' },
      ready,
      p,
    )
    expect(unreadable.inputs).toEqual(ready.inputs)
    expect(unreadable.status).toEqual({
      state: 'unreadable',
      reason: 'settings read failed — store timeout',
    })
    expect(p.warn).toHaveBeenCalledWith(
      'camera-sensors: settings unreadable — keeping the previous mapping',
      expect.objectContaining({ tags: { deviceId: CAM } }),
    )
    const removed = await resolveCameraSensors(CAM, { state: 'not-configured' }, unreadable, p)
    expect(removed).toEqual({ status: { state: 'not-configured' }, inputs: [] })
  })

  it('a re-adopted sensor with a NEW numeric id re-resolves by stableId', async () => {
    const p = ports({ rows: [PIR_ROW], caps: new Map([[3299, ['motion']]]) })
    const ready = await resolveCameraSensors(CAM, configured(), null, p)
    // 3299 now belongs to a DIFFERENT device (reusing nothing but the number);
    // the PIR itself came back as 4100.
    p.setRows([
      { ...PIR_ROW, id: 3299, stableId: 'ha:other', name: 'Other' },
      { ...PIR_ROW, id: 4100 },
    ])
    p.setCaps(
      new Map([
        [3299, ['motion']],
        [4100, ['motion']],
      ]),
    )
    const r = await resolveCameraSensors(CAM, configured(), ready, p)
    expect(r.inputs).toEqual([
      {
        ref: { ...PIR_REF, mode: 'in-addition' },
        deviceId: 4100,
        mode: 'in-addition',
        ready: true,
      },
    ])
    expect(r.status).toMatchObject({ sensors: [{ state: 'ready', deviceId: 4100 }] })
  })

  it('keeps config order in status, sorts and dedupes inputs by device id', async () => {
    const A = { addonId: 'provider-homeassistant', stableId: 'ha:b' }
    const Z = { addonId: 'provider-zigbee', stableId: 'z:a' }
    const p = ports({
      rows: [
        { ...PIR_ROW, id: 20, ...A },
        { ...PIR_ROW, id: 10, ...Z },
      ],
      caps: new Map([
        [10, ['contact']],
        [20, ['motion']],
      ]),
    })
    const r = await resolveCameraSensors(CAM, configured([A, Z]), null, p)
    expect(r.inputs).toEqual([
      { ref: { ...Z, mode: 'in-addition' }, deviceId: 10, mode: 'in-addition', ready: true },
      { ref: { ...A, mode: 'in-addition' }, deviceId: 20, mode: 'in-addition', ready: true },
    ])
    expect(r.status.state === 'configured' ? r.status.sensors.map((s) => s.stableId) : []).toEqual([
      'ha:b',
      'z:a',
    ])
    expect(p.listByAddon).toHaveBeenCalledTimes(2)
    expect(p.sourceCapsOf).toHaveBeenCalledTimes(1)
  })
})

const GATE_REF = { addonId: 'provider-homeassistant', stableId: 'ha:porch-gate' }
const GATE_ROW: CameraSensorDeviceRow = { ...PIR_ROW, id: 3301, ...GATE_REF, name: 'Gate' }
type FakeSensorState = 'ready' | 'offline' | 'bindings-unreadable'
interface PortsWithInit {
  readonly pir?: FakeSensorState
  readonly gate?: FakeSensorState
}
/** The existing fakes, set per sensor: online + bound, or offline. `bindings-unreadable` fails the ONE batched bindings read — for every sensor. */
function portsWith(init: PortsWithInit) {
  const rows: CameraSensorDeviceRow[] = []
  const caps = new Map<number, readonly string[]>()
  if (init.pir !== undefined) {
    rows.push({ ...PIR_ROW, online: init.pir !== 'offline' })
    caps.set(PIR_ROW.id, ['motion'])
  }
  if (init.gate !== undefined) {
    rows.push({ ...GATE_ROW, online: init.gate !== 'offline' })
    caps.set(GATE_ROW.id, ['contact'])
  }
  const p = ports({ rows, caps })
  if (init.pir === 'bindings-unreadable' || init.gate === 'bindings-unreadable') {
    p.failSourceCaps('bindings timed out')
  }
  return p
}

describe('modes and readiness (D673 C1, C3)', () => {
  it('each attachment and each input carries its mode; cameraMotion is computed from the READY ones', async () => {
    const config: CameraSensorsConfig = {
      sensors: [
        { ...PIR_REF, mode: 'replace' },
        { ...GATE_REF, mode: 'confirm' },
      ],
    }
    const out = await resolveCameraSensors(
      103,
      { state: 'configured', config },
      null,
      portsWith({ pir: 'ready', gate: 'offline' }),
    )
    expect(out.status).toMatchObject({
      state: 'configured',
      cameraMotion: 'never',
      sensors: [
        { mode: 'replace', state: 'ready' },
        { mode: 'confirm', state: 'offline' },
      ],
    })
    expect(out.inputs.map((i) => [i.deviceId, i.mode, i.ready])).toEqual([
      [3299, 'replace', true],
      [3301, 'confirm', false],
    ])
  })
  it('a READ that fails keeps the prior readiness (D49) — a Replace sensor does not hand the camera back on a blip', async () => {
    const config: CameraSensorsConfig = { sensors: [{ ...PIR_REF, mode: 'replace' }] }
    const first = await resolveCameraSensors(
      103,
      { state: 'configured', config },
      null,
      portsWith({ pir: 'ready' }),
    )
    const blip = await resolveCameraSensors(
      103,
      { state: 'configured', config },
      first,
      portsWith({ pir: 'bindings-unreadable' }),
    )
    expect(blip.status).toMatchObject({
      cameraMotion: 'never',
      sensors: [{ state: 'unreadable', mode: 'replace' }],
    })
    expect(blip.inputs).toEqual([
      { ref: { ...PIR_REF, mode: 'replace' }, deviceId: 3299, mode: 'replace', ready: true },
    ])
  })
  it('a mode change alone re-reads nothing new and changes the input', async () => {
    const first = await resolveCameraSensors(
      103,
      { state: 'configured', config: { sensors: [{ ...PIR_REF, mode: 'in-addition' }] } },
      null,
      portsWith({ pir: 'ready' }),
    )
    const next = await resolveCameraSensors(
      103,
      { state: 'configured', config: { sensors: [{ ...PIR_REF, mode: 'replace' }] } },
      first,
      portsWith({ pir: 'ready' }),
    )
    expect(next.inputs[0]?.mode).toBe('replace')
    expect(next.status).toMatchObject({ cameraMotion: 'never' })
  })
  it('the prior readiness is looked up PER REF when every read fails (D49, review M2)', async () => {
    const config: CameraSensorsConfig = {
      sensors: [
        { ...PIR_REF, mode: 'replace' },
        { ...GATE_REF, mode: 'confirm' },
      ],
    }
    const setting: CameraSensorsSetting = { state: 'configured', config }
    const first = await resolveCameraSensors(
      103,
      setting,
      null,
      portsWith({ pir: 'ready', gate: 'offline' }),
    )
    const blip = await resolveCameraSensors(
      103,
      setting,
      first,
      portsWith({ pir: 'bindings-unreadable', gate: 'bindings-unreadable' }),
    )
    expect(blip.inputs.map((i) => [i.deviceId, i.ready])).toEqual([
      [3299, true],
      [3301, false],
    ])
    expect(blip.status).toMatchObject({ cameraMotion: 'never' })
  })
  it('two refs on ONE device: the first in config order drives it, and the drop is said (D391, review L2)', async () => {
    const TWIN = { addonId: PIR_REF.addonId, stableId: 'ha:porch-pir-twin' }
    const p = ports({
      rows: [PIR_ROW, { ...PIR_ROW, ...TWIN }],
      caps: new Map([[3299, ['motion']]]),
    })
    const config: CameraSensorsConfig = {
      sensors: [
        { ...PIR_REF, mode: 'confirm' },
        { ...TWIN, mode: 'replace' },
      ],
    }
    const r = await resolveCameraSensors(103, { state: 'configured', config }, null, p)
    expect(r.inputs.map((i) => [i.deviceId, i.mode])).toEqual([[3299, 'confirm']])
    expect(p.warn).toHaveBeenCalledWith(
      'camera-sensors: input dropped — another ref resolves to the same device',
      expect.objectContaining({
        tags: { deviceId: 103 },
        meta: expect.objectContaining({
          mode: 'replace',
          keptMode: 'confirm',
          sensorDeviceId: 3299,
        }),
      }),
    )
  })
})
