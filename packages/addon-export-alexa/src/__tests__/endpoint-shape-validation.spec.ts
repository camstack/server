/**
 * Every endpoint shape this skill can publish, checked against Amazon's
 * discovery rules (`validate-endpoint.ts`, D769), and against the one rule
 * Amazon enforces at runtime rather than at discovery: a property declared
 * `retrievable: true` must come back from `Alexa/ReportState`.
 *
 * The matrix is built through the REAL builders from fake registries, so a new
 * capability is covered as soon as a device that triggers it is added below.
 * Amazon rejects whole endpoints on an invalid capability — that is how a
 * one-preset ModeController and two same-named presets each made a camera and
 * all its children vanish.
 */
import type { AlexaEndpoint } from '../endpoints/types.js'
import { describe, expect, it } from 'vitest'
import { validateAlexaEndpoint } from '../endpoints/validate-endpoint.js'
import { buildEndpointsForExposedDevice } from '../handlers/discovery.js'
import type { DetectionSensorClass } from '../handlers/endpoint-id.js'
import { handleReportState } from '../handlers/report-state.js'
import { type FakeDevice, fakeBuildContext, quietLogger } from './helpers/fake-device-api.js'

interface Scenario {
  readonly name: string
  readonly devices: readonly FakeDevice[]
  readonly presets?: Readonly<Record<number, ReadonlyArray<{ name: string }>>>
  readonly detectionClasses?: readonly DetectionSensorClass[]
  readonly snapshots?: boolean
  /** R4 (D779): the camera's ObjectDetectionSensor + DataController classes. */
  readonly objectDetection?: readonly ('person' | 'package')[]
}

const cam = (capNames: readonly string[], extra: Partial<FakeDevice> = {}): FakeDevice => ({
  id: 1,
  name: 'Front door',
  type: 'camera',
  capNames,
  ...extra,
})

export const SCENARIOS: readonly Scenario[] = [
  { name: 'bare camera', devices: [cam([])] },
  { name: 'motion camera', devices: [cam(['motion'])] },
  { name: 'doorbell + intercom', devices: [cam(['doorbell', 'intercom', 'motion'])] },
  {
    name: 'doorbell child',
    devices: [
      cam(['motion']),
      { id: 2, name: 'Bell', type: 'button', capNames: [], role: 'doorbell', parentDeviceId: 1 },
    ],
  },
  { name: 'ptz, no presets', devices: [cam(['ptz'])] },
  { name: 'ptz, one preset', devices: [cam(['ptz'])], presets: { 1: [{ name: 'Gate' }] } },
  {
    name: 'ptz, duplicate presets',
    devices: [cam(['ptz'])],
    presets: { 1: [{ name: 'Gate' }, { name: 'gate' }, { name: 'Drive' }] },
  },
  { name: 'autotrack + privacy', devices: [cam(['ptz-autotrack', 'privacy-mask'])] },
  { name: 'battery camera', devices: [cam(['battery', 'motion'])] },
  {
    name: 'accessories',
    devices: [
      cam(['motion']),
      {
        id: 3,
        name: 'Front door Siren',
        type: 'siren',
        capNames: ['switch'],
        role: 'siren',
        parentDeviceId: 1,
      },
      {
        id: 4,
        name: 'Floodlight',
        type: 'light',
        capNames: ['switch', 'brightness'],
        role: 'floodlight',
        parentDeviceId: 1,
      },
    ],
  },
  {
    name: 'alarm panel',
    devices: [{ id: 1, name: 'Casa', type: 'alarm-panel', capNames: ['alarm-panel'] }],
  },
  { name: 'nameless camera', devices: [cam(['motion'], { name: '' })] },
  {
    name: 'detection sensors (R1)',
    devices: [cam(['motion'])],
    detectionClasses: ['person', 'vehicle', 'animal', 'package'],
  },
  {
    name: 'doorbell with detection sensors',
    devices: [cam(['doorbell', 'intercom'])],
    detectionClasses: ['person', 'package'],
  },
  // R5 — non-camera devices.
  {
    name: 'lock',
    devices: [{ id: 1, name: 'Front lock', type: 'lock', capNames: ['lock-control', 'battery'] }],
  },
  {
    name: 'contact sensor',
    devices: [{ id: 1, name: 'Door', type: 'sensor', capNames: ['contact'] }],
  },
  {
    name: 'multi sensor',
    devices: [
      {
        id: 1,
        name: 'Hall',
        type: 'sensor',
        capNames: ['motion', 'temperature-sensor', 'humidity-sensor', 'ambient-light-sensor'],
      },
    ],
  },
  {
    name: 'dimmable light',
    devices: [{ id: 1, name: 'Porch', type: 'light', capNames: ['switch', 'brightness'] }],
  },
  { name: 'plain switch', devices: [{ id: 1, name: 'Fan', type: 'switch', capNames: ['switch'] }] },
  { name: 'siren', devices: [{ id: 1, name: 'Siren', type: 'siren', capNames: ['switch'] }] },
  {
    name: 'presence',
    devices: [{ id: 1, name: 'Anna', type: 'presence', capNames: ['presence'] }],
  },
  {
    name: 'thermostat temperature',
    devices: [{ id: 1, name: 'Living', type: 'thermostat', capNames: ['temperature-sensor'] }],
  },
  { name: 'camera with snapshots (R2)', devices: [cam(['motion', 'ptz'])], snapshots: true },
  {
    name: 'doorbell with snapshots and everything on',
    devices: [cam(['doorbell', 'intercom', 'motion', 'privacy-mask'])],
    detectionClasses: ['person', 'vehicle', 'animal', 'package'],
    snapshots: true,
  },
  // R4 (D779) — object detection + event history on the camera itself.
  { name: 'object detection, person only', devices: [cam([])], objectDetection: ['person'] },
  {
    name: 'object detection, person + package, with motion and snapshots',
    devices: [cam(['motion'])],
    objectDetection: ['person', 'package'],
    snapshots: true,
  },
  {
    name: 'doorbell + intercom + ptz with object detection and everything on',
    devices: [cam(['doorbell', 'intercom', 'motion', 'ptz', 'privacy-mask'])],
    presets: { 1: [{ name: 'Gate' }, { name: 'Drive' }] },
    detectionClasses: ['person', 'package'],
    objectDetection: ['person', 'package'],
    snapshots: true,
  },
]

export async function buildScenario(s: Scenario): Promise<readonly AlexaEndpoint[]> {
  return buildEndpointsForExposedDevice(
    1,
    fakeBuildContext(s.devices, {
      presets: s.presets,
      ...(s.detectionClasses !== undefined ? { detectionClasses: s.detectionClasses } : {}),
      ...(s.snapshots === true ? { snapshots: true } : {}),
      ...(s.objectDetection !== undefined ? { objectDetection: s.objectDetection } : {}),
    }),
  )
}

describe("every built endpoint passes Amazon's discovery rules", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const endpoints = await buildScenario(scenario)
      expect(endpoints.length).toBeGreaterThan(0)
      expect(endpoints.flatMap((e) => validateAlexaEndpoint(e))).toEqual([])
    })
  }
})

it('the snapshot scenarios really declare SnapshotProvider', async () => {
  const eps = await buildScenario(SCENARIOS.find((s) => s.name === 'camera with snapshots (R2)')!)
  expect(eps[0]?.capabilities.map((c) => c.interface)).toContain(
    'Alexa.SmartVision.SnapshotProvider',
  )
})

describe("R4: the object-detection scenarios declare exactly Amazon's documented shape", () => {
  const find = async (name: string) => {
    const eps = await buildScenario(SCENARIOS.find((s) => s.name === name)!)
    return eps[0]!
  }

  it('ObjectDetectionSensor 1.0 with the configured classes and no properties', async () => {
    const camera = await find('object detection, person + package, with motion and snapshots')
    const ods = camera.capabilities.find(
      (c) => c.interface === 'Alexa.SmartVision.ObjectDetectionSensor',
    )
    expect(ods).toEqual({
      type: 'AlexaInterface',
      interface: 'Alexa.SmartVision.ObjectDetectionSensor',
      version: '1.0',
      configuration: {
        objectDetectionConfiguration: [{ imageNetClass: 'person' }, { imageNetClass: 'package' }],
      },
    })
  })

  it('DataController 1.0, instance Camera.SmartVisionData, targeting the sensor', async () => {
    const camera = await find('object detection, person only')
    const dc = camera.capabilities.find((c) => c.interface === 'Alexa.DataController')
    expect(dc).toEqual({
      type: 'AlexaInterface',
      interface: 'Alexa.DataController',
      instance: 'Camera.SmartVisionData',
      version: '1.0',
      configuration: {
        targetCapability: { name: 'Alexa.SmartVision.ObjectDetectionSensor', version: '1.0' },
        dataRetrievalSchema: { type: 'JSON', schema: 'SmartVisionData' },
        supportedAccess: ['BY_IDENTIFIER', 'BY_TIMESTAMP_RANGE'],
      },
    })
  })

  it('both sit on the CAMERA endpoint, beside RTC and EndpointHealth', async () => {
    const camera = await find('object detection, person only')
    expect(camera.endpointId).toBe('1')
    expect(camera.displayCategories[0]).toBe('CAMERA')
    const interfaces = camera.capabilities.map((c) => c.interface)
    expect(interfaces).toEqual(
      expect.arrayContaining([
        'Alexa.RTCSessionController',
        'Alexa.EndpointHealth',
        'Alexa.SmartVision.ObjectDetectionSensor',
        'Alexa.DataController',
      ]),
    )
  })

  it('switched off, neither is declared', async () => {
    const camera = await find('motion camera')
    const interfaces = camera.capabilities.map((c) => c.interface)
    expect(interfaces).not.toContain('Alexa.SmartVision.ObjectDetectionSensor')
    expect(interfaces).not.toContain('Alexa.DataController')
  })
})

describe('the validator catches what Amazon rejects', () => {
  const base: AlexaEndpoint = {
    endpointId: '1',
    manufacturerName: 'camstack',
    description: 'd',
    friendlyName: 'Cam',
    displayCategories: ['CAMERA'],
    capabilities: [{ type: 'AlexaInterface', interface: 'Alexa', version: '3' }],
  }
  const rules = (e: AlexaEndpoint): string =>
    validateAlexaEndpoint(e)
      .map((v) => v.rule)
      .join('|')

  it('an interface Amazon does not list (BatteryLevelSensor)', () => {
    expect(
      rules({
        ...base,
        capabilities: [
          ...base.capabilities,
          { type: 'AlexaInterface', interface: 'Alexa.BatteryLevelSensor', version: '3' },
        ],
      }),
    ).toMatch(/not in Amazon's interface list/)
  })

  it('a one-mode ModeController', () => {
    expect(
      rules({
        ...base,
        capabilities: [
          ...base.capabilities,
          {
            type: 'AlexaInterface',
            interface: 'Alexa.ModeController',
            version: '3',
            instance: 'ptz.preset',
            capabilityResources: {
              friendlyNames: [{ '@type': 'text', value: { text: 'Preset', locale: 'en-US' } }],
            },
            configuration: { supportedModes: [{ value: 'a' }] },
          },
        ],
      }),
    ).toMatch(/at least 2 supportedModes/)
  })

  it('a sensor without EndpointHealth, a missing base interface, a bad id', () => {
    expect(
      rules({
        ...base,
        endpointId: 'a/b',
        capabilities: [{ type: 'AlexaInterface', interface: 'Alexa.MotionSensor', version: '3' }],
      }),
    ).toMatch(/endpointId.*base Alexa interface.*requires Alexa.EndpointHealth|endpointId/)
  })

  it('an ObjectDetectionSensor with no class, an unknown class, or no EndpointHealth', () => {
    const ods = (classes: readonly string[]) => ({
      type: 'AlexaInterface' as const,
      interface: 'Alexa.SmartVision.ObjectDetectionSensor',
      version: '1.0',
      configuration: { objectDetectionConfiguration: classes.map((c) => ({ imageNetClass: c })) },
    })
    expect(rules({ ...base, capabilities: [...base.capabilities, ods([])] })).toMatch(
      /objectDetectionConfiguration/,
    )
    expect(rules({ ...base, capabilities: [...base.capabilities, ods(['dog'])] })).toMatch(
      /imageNetClass/,
    )
    expect(rules({ ...base, capabilities: [...base.capabilities, ods(['person'])] })).toMatch(
      /requires Alexa.EndpointHealth/,
    )
  })

  it('a DataController without an instance, a schema, or its target capability', () => {
    const dc = (extra: Record<string, unknown>, instance?: string) => ({
      type: 'AlexaInterface' as const,
      interface: 'Alexa.DataController',
      version: '1.0',
      ...(instance !== undefined ? { instance } : {}),
      configuration: {
        targetCapability: { name: 'Alexa.SmartVision.ObjectDetectionSensor', version: '1.0' },
        dataRetrievalSchema: { type: 'JSON', schema: 'SmartVisionData' },
        supportedAccess: ['BY_TIMESTAMP_RANGE'],
        ...extra,
      },
    })
    expect(rules({ ...base, capabilities: [...base.capabilities, dc({})] })).toMatch(
      /instance is required/,
    )
    expect(
      rules({
        ...base,
        capabilities: [...base.capabilities, dc({ dataRetrievalSchema: undefined }, 'x')],
      }),
    ).toMatch(/dataRetrievalSchema/)
    // targets an interface the endpoint does not declare
    expect(rules({ ...base, capabilities: [...base.capabilities, dc({}, 'x')] })).toMatch(
      /targetCapability/,
    )
    expect(
      rules({
        ...base,
        capabilities: [...base.capabilities, dc({ supportedAccess: ['BY_MAGIC'] }, 'x')],
      }),
    ).toMatch(/supportedAccess/)
  })

  it('an RTCSessionController endpoint that does not list CAMERA first', () => {
    expect(
      rules({
        ...base,
        displayCategories: ['DOORBELL', 'CAMERA'],
        capabilities: [
          ...base.capabilities,
          { type: 'AlexaInterface', interface: 'Alexa.RTCSessionController', version: '3' },
        ],
      }),
    ).toMatch(/CAMERA first/)
  })
})

/** A fake API that can answer every state read the ReportState handler makes. */
function stateApi(): Record<string, unknown> {
  const ok = <T>(v: T) => ({ query: async () => v })
  return {
    deviceStatus: { getStatus: ok({ online: true, lastChangedAt: 1 }) },
    motion: { getStatus: ok({ detected: false }) },
    privacyMask: { getStatus: ok({ enabled: false }) },
    ptzAutotrack: { getStatus: ok({ enabled: false }) },
    switch: { getStatus: ok({ on: true }) },
    brightness: { getStatus: ok({ percentage: 40 }) },
    deviceState: {
      getCapSlice: {
        query: async ({ capName }: { capName: string }) =>
          ({
            'lock-control': { state: 'locked', lastChangedAt: 1 },
            contact: { entryOpen: false, lastChangedAt: 1 },
            motion: { detected: false, lastDetectedAt: null, autoClearAfterMs: null },
            presence: {
              state: 'home',
              location: null,
              gps: null,
              batteryPercent: null,
              lastChangedAt: 1,
            },
            'temperature-sensor': { celsius: 21.34, lastFetchedAt: 1 },
            'humidity-sensor': { percent: 48, lastFetchedAt: 1 },
            switch: { on: true, lastChangedAt: 1 },
            brightness: { percentage: 40, lastChangedAt: 1 },
          })[capName] ?? null,
      },
    },
  }
}

describe('every retrievable property is answered by ReportState', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const ctx = fakeBuildContext(scenario.devices, {
        presets: scenario.presets,
        api: stateApi(),
        ...(scenario.detectionClasses !== undefined
          ? { detectionClasses: scenario.detectionClasses }
          : {}),
        ...(scenario.snapshots === true ? { snapshots: true } : {}),
        ...(scenario.objectDetection !== undefined
          ? { objectDetection: scenario.objectDetection }
          : {}),
      })
      const endpoints = await buildEndpointsForExposedDevice(1, ctx)
      for (const endpoint of endpoints) {
        const declared = endpoint.capabilities.flatMap((c) =>
          c.properties?.retrievable === true
            ? c.properties.supported.map((p) => `${c.interface}.${p.name}`)
            : [],
        )
        const res = (await handleReportState(
          { namespace: 'Alexa', name: 'ReportState', messageId: 'm', payloadVersion: '3' },
          { endpointId: endpoint.endpointId },
          { ctx: ctx.ctx, logger: quietLogger },
          { userId: 'u', username: 'u', scopes: [] },
        )) as { context: { properties: Array<{ namespace: string; name: string }> } }
        const answered = res.context.properties.map((p) => `${p.namespace}.${p.name}`)
        expect({
          endpoint: endpoint.endpointId,
          missing: declared.filter((d) => !answered.includes(d)),
        }).toEqual({
          endpoint: endpoint.endpointId,
          missing: [],
        })
      }
    })
  }
})
