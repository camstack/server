/**
 * Per-camera choice of which detection classes become Alexa sensors (D778).
 *
 * The camera's pipeline decides what MAY be offered (`DetectionClassSource`,
 * from `listEventKinds` — `package` only where a package zone / package
 * detection is configured); the operator's saved selection decides what IS
 * published. Nothing saved means nothing published — including every camera
 * that published all four classes under D772 (the migration).
 */
import { describe, expect, it } from 'vitest'
import {
  effectiveSensorClasses,
  parseSensorSelection,
  SENSOR_SELECTION_KEY,
  sensorSelectionField,
} from '../detection-sensors/sensor-selection.js'
import { endpointsSignature } from '../endpoint-signature.js'
import type { AlexaEndpoint } from '../endpoints/types.js'
import { buildEndpointsForExposedDevice } from '../handlers/discovery.js'
import {
  DETECTION_SENSOR_CLASSES,
  type DetectionSensorClass,
  detectionSensorEndpointId,
} from '../handlers/endpoint-id.js'
import { SyncEngine } from '../sync-engine.js'
import { fakeBuildContext, quietLogger } from './helpers/fake-device-api.js'

const ALL = DETECTION_SENSOR_CLASSES

describe('effectiveSensorClasses', () => {
  it('nothing saved publishes nothing, whatever the camera can detect', () => {
    expect(effectiveSensorClasses(ALL, null)).toEqual([])
  })

  it('a saved selection publishes the selected classes the camera produces', () => {
    expect(effectiveSensorClasses(ALL, ['package', 'person'])).toEqual(['person', 'package'])
  })

  it('a selected class the camera no longer produces is dropped', () => {
    // package support removed from the camera (package zone deleted)
    expect(effectiveSensorClasses(['person', 'vehicle'], ['person', 'package'])).toEqual(['person'])
  })

  it('an explicit empty selection publishes nothing', () => {
    expect(effectiveSensorClasses(ALL, [])).toEqual([])
  })
})

describe('parseSensorSelection (the per-device store)', () => {
  it('a key never written is "never saved" (null), not an empty selection', () => {
    expect(parseSensorSelection({})).toBeNull()
  })

  it('reads a saved selection, dropping unknown values', () => {
    expect(parseSensorSelection({ [SENSOR_SELECTION_KEY]: ['package', 'dragon'] })).toEqual([
      'package',
    ])
  })

  it('a saved empty selection stays an explicit empty selection', () => {
    expect(parseSensorSelection({ [SENSOR_SELECTION_KEY]: [] })).toEqual([])
  })

  it('a value of the wrong type reads as never saved', () => {
    expect(parseSensorSelection({ [SENSOR_SELECTION_KEY]: 'person' })).toBeNull()
  })
})

describe('sensorSelectionField (device settings)', () => {
  it('offers ONLY the classes the camera produces — no package without package support', () => {
    const field = sensorSelectionField({
      deviceId: 7,
      available: ['person', 'vehicle'],
      saved: null,
      enabledKey: 'alexa:7:enabled',
      masterOn: true,
    })
    expect(field.type).toBe('multiselect')
    if (field.type !== 'multiselect') throw new Error('unreachable')
    expect(field.options.map((o) => o.value)).toEqual(['person', 'vehicle'])
    expect(field.value).toEqual([])
    expect(field.key).toBe('alexa:7:detectionSensorClasses')
  })

  it('shows a saved class the camera lost as NOT selected', () => {
    const field = sensorSelectionField({
      deviceId: 7,
      available: ['person'],
      saved: ['person', 'package'],
      enabledKey: 'alexa:7:enabled',
      masterOn: true,
    })
    if (field.type !== 'multiselect') throw new Error('expected a multiselect')
    expect(field.value).toEqual(['person'])
  })

  it('says why there is nothing to choose when the camera detects nothing', () => {
    const field = sensorSelectionField({
      deviceId: 7,
      available: [],
      saved: null,
      enabledKey: 'alexa:7:enabled',
      masterOn: true,
    })
    expect(field.type).toBe('info')
  })

  it('says the integration switch is off instead of offering a dead choice', () => {
    const field = sensorSelectionField({
      deviceId: 7,
      available: ['person'],
      saved: null,
      enabledKey: 'alexa:7:enabled',
      masterOn: false,
    })
    expect(field.type).toBe('info')
  })
})

/**
 * The migration, discriminated: a camera that published all four sensors
 * under D772 (four `__det_` ids recorded as exported) and has NO saved
 * selection must lose all four on its next reconcile; one with a saved
 * selection keeps exactly what it chose. A build that ignored the selection
 * would push all four again and delete nothing — both assertions fail.
 */
describe('migration: D772 cameras move to the empty default', () => {
  const CAMERA = 1
  const legacyIds = [String(CAMERA), ...ALL.map((c) => detectionSensorEndpointId(CAMERA, c))]

  async function reconcileWith(saved: readonly DetectionSensorClass[] | null) {
    const posted: AlexaEndpoint[][] = []
    const deleted: string[][] = []
    let exported: Record<number, readonly string[]> = { [CAMERA]: legacyIds }
    // A signature unlike anything the new build produces: the D772 shape.
    let signatures: Record<number, string> = { [CAMERA]: 'legacy-shape' }
    const engine = new SyncEngine({
      logger: quietLogger,
      listExposed: () => [{ deviceId: CAMERA, exposedAt: 0 }],
      listLinkedAccounts: () => [{ userId: 'u', username: 'u', linkedAt: 0 }],
      hasProactiveCredentials: () => true,
      buildEndpoints: (id) =>
        buildEndpointsForExposedDevice(
          id,
          fakeBuildContext(
            [{ id: CAMERA, name: 'Front door', type: 'camera', capNames: ['motion'] }],
            // What the live hub's DetectionClassSource persisted under D772.
            { detectionClasses: effectiveSensorClasses(ALL, saved) },
          ),
        ),
      filterForAccount: async (_u, endpoints) => endpoints,
      afterPush: () => {},
      mayRetire: (id) => id.includes('__det_'),
      postAddOrUpdate: async (_u, endpoints) => {
        posted.push([...endpoints])
        return true
      },
      postDelete: async (_u, ids) => {
        deleted.push([...ids])
        return true
      },
      getExportedEndpoints: () => exported,
      setExportedEndpoints: async (next) => {
        exported = { ...next }
      },
      getExportedSignatures: () => signatures,
      setExportedSignatures: async (next) => {
        signatures = { ...next }
      },
    })
    await engine.reconcileDevice(CAMERA)
    return { posted, deleted, exported, signatures }
  }

  it('no saved selection: every D772 sensor is deleted from Alexa', async () => {
    const r = await reconcileWith(null)
    expect(r.posted.flat().map((e) => e.endpointId)).toEqual([String(CAMERA)])
    expect(r.deleted).toEqual([ALL.map((c) => detectionSensorEndpointId(CAMERA, c))])
    expect(r.exported[CAMERA]).toEqual([String(CAMERA)])
  })

  it('a saved selection keeps exactly the chosen sensors and deletes the rest', async () => {
    const r = await reconcileWith(['person'])
    expect(r.posted.flat().map((e) => e.endpointId)).toEqual([
      String(CAMERA),
      detectionSensorEndpointId(CAMERA, 'person'),
    ])
    expect(r.deleted).toEqual([
      (['vehicle', 'animal', 'package'] as const).map((c) => detectionSensorEndpointId(CAMERA, c)),
    ])
  })

  it('the next reconcile with the same answer pushes nothing', async () => {
    const first = await reconcileWith(null)
    expect(first.signatures[CAMERA]).toBe(endpointsSignature(first.posted.flat()))
  })
})
