/**
 * D673 — only three places emit `MotionOnMotionChanged`: the camera-sensors
 * bridge (the camera's effective onboard motion), the device-activity source
 * and the runner's analyzer. A camera provider emits its raw push with
 * `providerMotionEvent`. Each rule goes red on its fixture; the last test runs
 * the real tree.
 */
import { describe, expect, it } from 'vitest'
import { itRealTree } from './lib/real-tree.js'
import { stripComments } from '../lib/walk-sources.ts'
import {
  checkHubMotionReadFacts,
  checkMotionSliceWriterFacts,
  checkOnboardMotionEmitterFacts,
  checkStaleExemptionFacts,
  checkStaleSliceExemptionFacts,
  collectOnboardMotionFiles,
  type GuardFile,
  MOTION_EMITTERS_DEFERRED,
  MOTION_SLICE_GENERIC_WRITERS,
  MOTION_SLICE_SENSOR_WRITERS,
} from '../onboard-motion-emitters-guard.ts'

const file = (rel: string, text: string): GuardFile => ({ rel, code: stripComments(text) })

const GRID_PATH = 'packages/system/src/builtins/camera-grid/grid-activity.ts'
const EMIT = `this.deps.eventBus.emit(createEvent(EventCategory.MotionOnMotionChanged, src, payload))`

describe('onboard motion emitters (D673)', () => {
  it('refuses a provider that emits MotionOnMotionChanged through createEvent', () => {
    expect(
      checkOnboardMotionEmitterFacts([
        file(
          'packages/addon-provider-x/src/cam.ts',
          `this.ctx.eventBus.emit(\n  createEvent(\n    EventCategory.MotionOnMotionChanged, src, { deviceId, detected: true, timestamp, source: 'onboard' }))`,
        ),
      ]),
    ).toHaveLength(1)
  })
  it('refuses a raw event object with that category', () => {
    expect(
      checkOnboardMotionEmitterFacts([
        file(
          'packages/addon-provider-x/src/cam.ts',
          `bus.emit({ id, timestamp: new Date(), source, category: EventCategory.MotionOnMotionChanged, data })`,
        ),
      ]),
    ).toHaveLength(1)
  })
  it('accepts providerMotionEvent, a subscription, the allowlisted emitters, tests and comments', () => {
    expect(
      checkOnboardMotionEmitterFacts([
        file(
          'packages/addon-provider-x/src/cam.ts',
          `this.ctx.eventBus.emit(providerMotionEvent(src, { deviceId, detected: true, timestamp, source: 'onboard' }))`,
        ),
        file(
          'packages/addon-export-x/src/sub.ts',
          `bus.subscribe({ category: EventCategory.MotionOnMotionChanged }, (e) => handle(e))`,
        ),
        file(
          'packages/addon-pipeline-orchestrator/src/orchestrator-bootstrap.ts',
          `eventBus.emit(createEvent(EventCategory.MotionOnMotionChanged, s, d))`,
        ),
        file(
          'packages/addon-provider-x/src/__tests__/cam.spec.ts',
          `bus.emit(createEvent(EventCategory.MotionOnMotionChanged, s, d))`,
        ),
        file(
          'packages/addon-provider-x/src/doc.ts',
          `// eventBus.emit(createEvent(EventCategory.MotionOnMotionChanged, s, d))\nexport const x = 1`,
        ),
      ]),
    ).toEqual([])
  })
  it('the camera-grid deferral is by EXACT path: the same code elsewhere is refused', () => {
    expect(MOTION_EMITTERS_DEFERRED.has(GRID_PATH)).toBe(true)
    expect(checkOnboardMotionEmitterFacts([file(GRID_PATH, EMIT)])).toEqual([])
    expect(
      checkOnboardMotionEmitterFacts([
        file('packages/system/src/builtins/camera-grid/other.ts', EMIT),
      ]),
    ).toHaveLength(1)
    expect(checkOnboardMotionEmitterFacts([file(`${GRID_PATH}.bak.ts`, EMIT)])).toHaveLength(1)
  })
  it('every deferral carries a reason', () => {
    for (const [p, reason] of MOTION_EMITTERS_DEFERRED) expect(reason.length, p).toBeGreaterThan(20)
  })
  it('names the line of the emit it refuses', () => {
    const [failure] = checkOnboardMotionEmitterFacts([
      file('packages/addon-provider-x/src/cam.ts', `const a = 1\n\n${EMIT}`),
    ])
    expect(failure).toContain('packages/addon-provider-x/src/cam.ts:3:')
  })
  it('reports an exemption whose file is gone or no longer emits', () => {
    const allowed = new Set(['a/gone.ts', 'a/quiet.ts', 'a/live.ts'])
    const deferred = new Map([
      ['d/gone.ts', 'a reason that is long enough'],
      ['d/quiet.ts', 'a reason that is long enough'],
    ])
    const failures = checkStaleExemptionFacts(
      [
        file('a/quiet.ts', 'export const x = 1'),
        file('a/live.ts', EMIT),
        file('d/quiet.ts', 'export const y = 1'),
      ],
      allowed,
      deferred,
    )
    expect(failures).toHaveLength(4)
    expect(failures.join('\n')).toMatch(/a\/gone\.ts.*no longer exists/)
    expect(failures.join('\n')).toMatch(/a\/quiet\.ts.*no longer emits/)
    expect(failures.join('\n')).toMatch(/d\/gone\.ts.*deferred/)
    expect(failures.join('\n')).not.toContain('a/live.ts')
  })
  itRealTree('the real tree passes, and every exemption is live', () => {
    const files = collectOnboardMotionFiles()
    expect(checkOnboardMotionEmitterFacts(files)).toEqual([])
    expect(checkStaleExemptionFacts(files)).toEqual([])
    expect(checkMotionSliceWriterFacts(files)).toEqual([])
    expect(checkStaleSliceExemptionFacts(files)).toEqual([])
    expect(checkHubMotionReadFacts(files)).toEqual([])
  })
})

describe('the camera motion slice has one writer, the orchestrator (D696)', () => {
  const PROVIDER = 'packages/addon-provider-x/src/cam.ts'
  const RUNNER = 'packages/addon-pipeline/src/pipeline-runner/index.ts'
  const ORCHESTRATOR = 'packages/addon-pipeline-orchestrator/src/camera-sensors/motion-slice-hub.ts'
  const BOOTSTRAP = 'packages/addon-pipeline-orchestrator/src/orchestrator-bootstrap.ts'
  const SENSOR = 'packages/addon-provider-homematic/src/devices/hm-sensor-device.ts'

  it('refuses a provider writing the slice, in every form, naming path:line', () => {
    const forms = [
      `this.setCapSlice(motionCapability, { detected: true, lastDetectedAt: now, autoClearAfterMs: null })`,
      `this.runtimeState.setCapState('motion', { detected: false })`,
      `this.runtimeState.patchCapState(motionCapability.name, { detected: false })`,
      `this.state.motion.detected = true`,
      // review F6: the forms the first version did not see
      `this.state.motion = { detected: true, lastDetectedAt: 1, autoClearAfterMs: null }`,
      `this.state['motion'] = { detected: true }`,
      `this.state["motion"].detected = true`,
    ]
    for (const form of forms) {
      const [failure, ...rest] = checkMotionSliceWriterFacts([
        file(PROVIDER, `const a = 1\n${form}`),
      ])
      expect(rest, form).toEqual([])
      expect(failure, form).toContain(`${PROVIDER}:2:`)
    }
  })
  it('refuses the runner writing it through deviceState (the D475 phase-machine write)', () => {
    const failures = checkMotionSliceWriterFacts([
      file(
        RUNNER,
        `const dev = await this.ctx.fetchDevice(deviceId)\nawait dev.deviceState.setCapSlice({ capName: 'motion', slice })`,
      ),
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain(`${RUNNER}:2:`)
  })
  it('accepts the orchestrator, a named sensor writing its own slice, reads, another cap, tests and comments', () => {
    expect(MOTION_SLICE_SENSOR_WRITERS.has(SENSOR)).toBe(true)
    expect(
      checkMotionSliceWriterFacts([
        file(
          ORCHESTRATOR,
          `await api.deviceState.setCapSlice.mutate({ deviceId, capName: 'motion', slice })`,
        ),
        file(SENSOR, `this.runtimeState.setCapState('motion', { detected: true })`),
        file(
          PROVIDER,
          `const s = await api.deviceState.getCapSlice.query({ deviceId, capName: 'motion' })`,
        ),
        file(PROVIDER, `this.setCapSlice(batteryCapability, { percentage: 5 })`),
        file(
          'packages/addon-provider-x/src/__tests__/cam.spec.ts',
          `this.setCapSlice(motionCapability, s)`,
        ),
        file(PROVIDER, `// this.setCapSlice(motionCapability, s)\nexport const x = 1`),
      ]),
    ).toEqual([])
  })
  it('a sensor exemption is by EXACT path: the same write in a sibling file is refused', () => {
    expect(
      checkMotionSliceWriterFacts([
        file(
          'packages/addon-provider-homematic/src/devices/hm-camera-device.ts',
          `this.runtimeState.setCapState('motion', { detected: true })`,
        ),
      ]),
    ).toHaveLength(1)
  })
  it('every sensor exemption carries a reason', () => {
    for (const [p, reason] of MOTION_SLICE_SENSOR_WRITERS)
      expect(reason.length, p).toBeGreaterThan(20)
  })
  it('reports a slice exemption whose file is gone or no longer writes', () => {
    const failures = checkStaleSliceExemptionFacts(
      [
        file('a/quiet.ts', 'export const x = 1'),
        file('s/live.ts', `this.runtimeState.setCapState('motion', { detected: true })`),
      ],
      new Set(['a/quiet.ts', 'a/gone.ts']),
      new Map([
        ['s/live.ts', 'a reason that is long enough'],
        ['s/gone.ts', 'a reason that is long enough'],
      ]),
      new Map(),
    )
    expect(failures).toHaveLength(3)
    expect(failures.join('\n')).toMatch(/a\/quiet\.ts.*no longer writes/)
    expect(failures.join('\n')).toMatch(/s\/gone\.ts.*sensor slice-writer.*no longer exists/)
    expect(failures.join('\n')).not.toContain('s/live.ts')
  })

  it('review F6: a constant cap name, and a shorthand `capName` inside a slice write, are seen', () => {
    const constant = checkMotionSliceWriterFacts([
      file(
        PROVIDER,
        `const MOTION = 'motion'\nthis.runtimeState.setCapState(MOTION, { detected: true })`,
      ),
    ])
    expect(constant).toHaveLength(1)
    expect(constant[0]).toContain(`${PROVIDER}:2:`)
    const aliased = checkMotionSliceWriterFacts([
      file(
        PROVIDER,
        `const CAP = motionCapability.name\nawait dev.deviceState.setCapSlice({ capName: CAP, slice })`,
      ),
    ])
    expect(aliased).toHaveLength(1)
    const shorthand = checkMotionSliceWriterFacts([
      file(
        PROVIDER,
        `const capName = pick()\nawait api.deviceState.setCapSlice.mutate({ deviceId, capName, slice })`,
      ),
    ])
    expect(shorthand).toHaveLength(1)
    // A constant naming another cap is not motion.
    expect(
      checkMotionSliceWriterFacts([
        file(PROVIDER, `const BATTERY = 'battery'\nthis.runtimeState.setCapState(BATTERY, s)`),
      ]),
    ).toEqual([])
  })
  it('review F6: the orchestrator exemption is the one hub-store module, not the whole bootstrap', () => {
    expect(
      checkMotionSliceWriterFacts([
        file(
          BOOTSTRAP,
          `await api.deviceState.setCapSlice.mutate({ deviceId, capName: 'motion', slice })`,
        ),
      ]),
    ).toHaveLength(1)
  })

  it('the framework`s generic writers are exempt by EXACT path, each with a reason', () => {
    const GENERIC = 'packages/types/src/device/base-device.ts'
    const shorthand = `await dev.deviceState.setCapSlice({ capName, slice })`
    expect(MOTION_SLICE_GENERIC_WRITERS.has(GENERIC)).toBe(true)
    expect(checkMotionSliceWriterFacts([file(GENERIC, shorthand)])).toEqual([])
    expect(
      checkMotionSliceWriterFacts([file('packages/types/src/device/other-device.ts', shorthand)]),
    ).toHaveLength(1)
    for (const [p, reason] of MOTION_SLICE_GENERIC_WRITERS)
      expect(reason.length, p).toBeGreaterThan(20)
  })
})

describe('a camera provider serves both motion reads from the hub (D696)', () => {
  const PROVIDER = 'packages/addon-provider-x/src/cam.ts'
  it('refuses a provider that calls a hub motion read directly (it would serve only isDetected)', () => {
    const failures = checkHubMotionReadFacts([
      file(
        PROVIDER,
        `const p = {\n  isDetected: async () => readHubMotionDetected(this.ctx.api.deviceState, this.id),\n}`,
      ),
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(
      /^packages\/addon-provider-x\/src\/cam\.ts:2: .*hubMotionNativeProvider/,
    )
  })
  it('accepts the builder, the read module itself, and tests', () => {
    expect(
      checkHubMotionReadFacts([
        file(
          PROVIDER,
          `const p = hubMotionNativeProvider(this.ctx.api.deviceState, this.id, 'Cam')`,
        ),
        file('packages/types/src/device/hub-motion-read.ts', `return readHubMotionStatus(s, id)`),
        file('packages/addon-provider-x/src/__tests__/cam.spec.ts', `readHubMotionDetected(s, 1)`),
      ]),
    ).toEqual([])
  })
})
