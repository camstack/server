import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../generated/capability-router-map.js'

/**
 * A `defaultActive: true` wrapper is auto-bound by
 * `device-manager.getBindings` step 2 to every device whose type its
 * `deviceTypes` admits — and a cap that declares NO `deviceTypes` is admitted
 * by EVERY type. So an undeclared `deviceTypes` on a default wrapper is not a
 * missing annotation, it is a fleet-wide bind.
 *
 * That is exactly how the whole camera battery (snapshot, detection-pipeline,
 * camera-streams, webrtc-session, camera-pipeline-config, pipeline-analytics,
 * videoclips, motion-detection, audio-analysis) came to be bound to a Homematic
 * button child: 302 non-camera devices each carrying 9 meaningless bindings,
 * every one of them a real aggregate round-trip that could only time out.
 *
 * The gate is cheap to state and impossible to remember, so it is a test: a NEW
 * default wrapper must say which device types it is for.
 */
describe('defaultActive wrappers declare deviceTypes', () => {
  it('every cap with defaultActive:true declares a non-empty deviceTypes', () => {
    const offenders = ALL_CAPABILITY_DEFINITIONS.filter(
      (def) => def.defaultActive === true && (def.deviceTypes?.length ?? 0) === 0,
    ).map((def) => def.name)

    expect(
      offenders,
      `these caps auto-bind to EVERY device because they declare no deviceTypes: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('only device-scoped caps declare defaultActive', () => {
    // `defaultActive` is meaningless on a system cap — there is no device to
    // bind it to, and `deviceTypes` would never be consulted.
    const offenders = ALL_CAPABILITY_DEFINITIONS.filter(
      (def) => def.defaultActive === true && def.scope !== 'device',
    ).map((def) => def.name)

    expect(offenders).toEqual([])
  })
})
