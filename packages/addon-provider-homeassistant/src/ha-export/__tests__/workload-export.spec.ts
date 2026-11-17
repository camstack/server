/**
 * The workload export (#585): the state and the resources as sensors (the
 * resources read through a dotted path into `resources`), the verbs as
 * buttons routed to the `workload` cap. Power is not here — it is the
 * `switch` a workload with start and stop registers from its power hint.
 */
import { WorkloadStatusSchema, type WorkloadStatus } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  applyCapCommand,
  type CapCommandDevice,
  CAP_COMMAND_ROUTES,
  hasButtonCommandRoute,
} from '../command-routes.js'
import { CAP_ENTITY_MAP, CAPS_NOT_EXPORTED, readCapField } from '../entity-catalog.js'
import { projectCapSlice } from '../state-projector.js'

const UNKNOWN: WorkloadStatus = WorkloadStatusSchema.parse({
  state: null,
  since: null,
  hostDeviceId: null,
  image: null,
  os: null,
  version: null,
  autostart: null,
  resources: {
    cpuPercent: null,
    memoryUsedBytes: null,
    memoryLimitBytes: null,
    vcpus: null,
    diskUsedBytes: null,
    diskTotalBytes: null,
    netRxKbps: null,
    netTxKbps: null,
    load1: null,
    temperature: null,
  },
  ports: [],
  addresses: [],
  updateAvailable: null,
  lastFetchedAt: 0,
})

function fakeWorkload(calls: string[], fail?: string): CapCommandDevice {
  const verb = (name: string) => async (): Promise<undefined> => {
    if (name === fail) throw new Error(`${name} refused by the platform`)
    calls.push(name)
    return undefined
  }
  return {
    workload: {
      start: verb('start'),
      stop: verb('stop'),
      restart: verb('restart'),
      pause: verb('pause'),
      resume: verb('resume'),
      forceStop: verb('forceStop'),
      getStatus: async () => null,
      getOptions: async () => ({
        supportsStart: true,
        supportsStop: true,
        supportsRestart: true,
        supportsPause: true,
        supportsForceStop: true,
        hasResources: true,
        hasPorts: false,
        hasAddresses: false,
        hasAutostart: false,
        hasUpdateCheck: false,
      }),
    },
  }
}

describe('workload export', () => {
  it('is mapped, and its power stays the switch of the power hint', () => {
    expect(CAPS_NOT_EXPORTED.some((e) => e.cap === 'workload')).toBe(false)
    const mapping = CAP_ENTITY_MAP['workload']
    expect(mapping?.platform).toBe('sensor')
    expect(mapping?.field).toBe('state')
    expect(Object.values(mapping?.extras ?? {}).some((e) => e.platform === 'switch')).toBe(false)
    expect(mapping?.extras?.['temperature']).toMatchObject({
      field: 'resources.temperature',
      deviceClass: 'temperature',
      unit: '°C',
    })
  })

  it('routes every button it declares, and no other', () => {
    const declared = Object.keys(CAP_ENTITY_MAP['workload']?.commands ?? {}).sort()
    expect(declared).toEqual(['force-stop', 'pause', 'restart', 'resume'])
    for (const suffix of declared) expect(hasButtonCommandRoute('workload', suffix)).toBe(true)
    expect(Object.keys(CAP_COMMAND_ROUTES['workload']?.commands ?? {}).sort()).toEqual(declared)
  })

  it('publishes NOTHING for a workload whose state and readings are unknown', () => {
    const projection = projectCapSlice('camstack-981', 'workload', { ...UNKNOWN })
    if (projection.kind !== 'values') throw new Error(`unexpected ${projection.kind}`)
    expect(projection.values).toEqual([])
  })

  it('publishes the state and the readings that are reported, through the nested path', () => {
    const projection = projectCapSlice('camstack-981', 'workload', {
      ...UNKNOWN,
      state: 'running',
      version: '1.40.2',
      updateAvailable: true,
      resources: { ...UNKNOWN.resources, cpuPercent: 23.5, temperature: 48 },
    })
    if (projection.kind !== 'values') throw new Error(`unexpected ${projection.kind}`)
    const byTopic = new Map(projection.values.map((v) => [v.topic.split('/').at(-1), v.value]))
    expect(byTopic.get('workload')).toBe('running')
    expect(byTopic.get('workload_cpu')).toBe('23.5')
    expect(byTopic.get('workload_temperature')).toBe('48')
    expect(byTopic.get('workload_version')).toBe('1.40.2')
    expect(byTopic.get('workload_update_available')).toBe('true')
    expect(byTopic.has('workload_memory')).toBe(false)
  })

  it('reads a dotted field, treating a null parent as not reported and an absent one as missing', () => {
    expect(readCapField({ resources: { cpuPercent: 4 } }, 'resources.cpuPercent')).toEqual({
      present: true,
      value: 4,
    })
    expect(readCapField({ resources: null }, 'resources.cpuPercent')).toEqual({
      present: true,
      value: null,
    })
    expect(readCapField({}, 'resources.cpuPercent')).toEqual({ present: false })
    expect(readCapField({ state: 'running' }, 'state')).toEqual({ present: true, value: 'running' })
  })

  it('sends each button to its workload method', async () => {
    const calls: string[] = []
    const device = fakeWorkload(calls)
    for (const verb of ['restart', 'force-stop', 'pause', 'resume'] as const) {
      const outcome = await applyCapCommand(device, { kind: 'workload-verb', deviceId: 981, verb })
      expect(outcome).toEqual({ ok: true })
    }
    expect(calls).toEqual(['restart', 'forceStop', 'pause', 'resume'])
  })

  it('says why when the platform refuses, and when nothing serves the cap', async () => {
    const refused = await applyCapCommand(fakeWorkload([], 'restart'), {
      kind: 'workload-verb',
      deviceId: 981,
      verb: 'restart',
    })
    expect(refused).toMatchObject({ ok: false, reason: 'refused', capName: 'workload' })
    const none = await applyCapCommand({}, { kind: 'workload-verb', deviceId: 981, verb: 'pause' })
    expect(none).toMatchObject({ ok: false, reason: 'no-provider', capName: 'workload' })
  })
})
