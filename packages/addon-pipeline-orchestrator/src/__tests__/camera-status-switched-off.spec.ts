/**
 * `CameraStatus.switchedOff`, recomposed from the AUTHORITIES (D113).
 *
 * The badge outlives the switch group. `getCameraSwitches` is a deprecated
 * compatibility surface and will be deleted; this field is not, because
 * "disabled must never look like broken" is a rule about status and not about a
 * control panel. So the status service reads the authorities itself and
 * composes the badge with `composeSwitchedOff` — no group in the middle.
 *
 * What these pin is the 2026-08-08 incident, in its new home. Measured on the
 * live hub: `getCameraStatus(105)` returned `switchedOff: []` at the very
 * moment the operator had `stream-broker` AND `recording` switched off, and the
 * camera read as BROKEN on every surface. The empty list was not the bug — the
 * bug was that the emptiness travelled without the reason it was empty. Three
 * outcomes must stay three:
 *
 *  - READ    — every authority answered. `[]` is the positive claim "nothing is
 *              off", and a quiet camera really is broken.
 *  - PARTIAL — at least one authority did not answer. The list is a FLOOR;
 *              `degraded` names `'switches'` with reason `'partial'`.
 *  - NOT READ— the whole read timed out or threw. `boundedStage` marks it.
 *
 * Neutralisation-verified: dropping the `unreadable` branch from
 * `buildSwitchStage` turns "a recorder that did not answer is PARTIAL" red
 * while every other test here stays green — which is exactly the shape of the
 * original incident.
 */
import type {
  AddonApi,
  CameraSwitchDerivationInput,
  IScopedLogger,
  PipelineAssignment,
  RunnerCameraConfig,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { CameraStatusService } from '../camera-status-service.js'
import type { AudioNodeAssignment } from '../orchestrator-types.js'
import { RepeatWarnSampler } from '../repeat-warn-sampler.js'
import { authoritiesWithOff, healthyAuthorities } from './camera-status-switch-authorities.js'

const DEVICE_ID = 105

const SILENT_LOGGER: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: (): IScopedLogger => SILENT_LOGGER,
  withTags: (): IScopedLogger => SILENT_LOGGER,
}

/**
 * No api → every remote stage degrades to `null`, which is what we want: the
 * switch read is injected, so this isolates the recomposition.
 */
function makeService(
  switchAuthoritiesFor: (deviceId: number) => Promise<CameraSwitchDerivationInput>,
): CameraStatusService {
  return new CameraStatusService({
    api: (): AddonApi => null as never,
    logger: SILENT_LOGGER,
    warnSampler: new RepeatWarnSampler(),
    getAssignment: (): PipelineAssignment | null => null,
    getAudioAssignment: (): AudioNodeAssignment | null => null,
    getCameraConfig: (): RunnerCameraConfig | null => null,
    hasCameraConfig: (): boolean => true,
    getPendingReason: (): string | undefined => undefined,
    assignSource: (): string => 'hub',
    listAssignedDeviceIds: (): readonly number[] => [DEVICE_ID],
    isSessionCamera: (): boolean => false,
    switchAuthoritiesFor,
    cameraSensorsFor: () => ({ state: 'not-configured' }),
  })
}

describe('CameraStatus.switchedOff — recomposed from the authorities', () => {
  it('is EMPTY and UNDEGRADED for a camera with everything on — so quiet means broken', async () => {
    const status = await makeService(async () => healthyAuthorities(DEVICE_ID)).getCameraStatus(
      DEVICE_ID,
    )
    expect(status.switchedOff).toEqual([])
    expect(status.degraded.map((d) => d.stage)).not.toContain('switches')
  })

  it('names the two functions the operator turned off — the 2026-08-08 camera', async () => {
    // The exact pair that read as `[]` on the live hub: a soft-disabled device
    // and a recorder with `enabled: false`. Both are read from their own
    // authority now, not from a group that could time out as a whole.
    const status = await makeService(async () =>
      authoritiesWithOff(DEVICE_ID, ['stream-broker', 'recording']),
    ).getCameraStatus(DEVICE_ID)
    expect([...status.switchedOff].sort()).toEqual(['recording', 'stream-broker'])
  })

  it('reads a deactivated detection binding as switched off — not as a dead pipeline', async () => {
    const status = await makeService(async () =>
      authoritiesWithOff(DEVICE_ID, ['object-detection']),
    ).getCameraStatus(DEVICE_ID)
    expect(status.switchedOff).toContain('object-detection')
  })

  it('an authority that did NOT answer marks the stage PARTIAL, and the list is a floor', async () => {
    // THE regression guard. `recordingEnabled: null` is "we could not read the
    // recorder": not off, not on. The list must still carry the functions we
    // COULD read, and the payload must say the answer is incomplete — an
    // undegraded `[]` here is the inversion that paints a switched-off camera
    // as broken.
    const status = await makeService(async () =>
      healthyAuthorities(DEVICE_ID, { recordingEnabled: null, notificationsMuted: true }),
    ).getCameraStatus(DEVICE_ID)
    expect(status.switchedOff).toEqual(['notifications'])
    const switches = status.degraded.find((d) => d.stage === 'switches')
    expect(switches?.reason).toBe('partial')
  })

  it('a bindings read that failed degrades — it never reports the wrappers as ON', async () => {
    const status = await makeService(async () =>
      healthyAuthorities(DEVICE_ID, { bindableCapNames: null, activeWrapperCapNames: null }),
    ).getCameraStatus(DEVICE_ID)
    expect(status.switchedOff).toEqual([])
    expect(status.degraded.find((d) => d.stage === 'switches')?.reason).toBe('partial')
  })

  it('a whole read that THREW is NOT READ, never a claim that nothing is off', async () => {
    const status = await makeService(async () => {
      throw new Error('deviceManager unreachable')
    }).getCameraStatus(DEVICE_ID)
    expect(status.switchedOff).toEqual([])
    expect(status.degraded.find((d) => d.stage === 'switches')?.reason).toBe('error')
  })

  it('a camera lacking a function entirely is neither off nor partial', async () => {
    // A deployment with no audio analyzer has no `audio-analysis` to switch
    // off. Reporting it either way puts a permanent badge on every camera.
    const status = await makeService(async () =>
      healthyAuthorities(DEVICE_ID, {
        bindableCapNames: ['detection-pipeline'],
        activeWrapperCapNames: ['detection-pipeline'],
      }),
    ).getCameraStatus(DEVICE_ID)
    expect(status.switchedOff).toEqual([])
    expect(status.degraded.map((d) => d.stage)).not.toContain('switches')
  })

  it('an unreadable privacy mask does NOT degrade the badge', async () => {
    // The mask can never contribute to `switchedOff` (its ON means "video is
    // obscured", not "this function works"), so failing to read it cannot make
    // the badge incomplete. Marking it partial would put a permanent "could not
    // read" on every camera whose 3.6s mask probe timed out — which is most of
    // them — and drown the partial that means something.
    const status = await makeService(async () =>
      healthyAuthorities(DEVICE_ID, { privacyMask: null }),
    ).getCameraStatus(DEVICE_ID)
    expect(status.switchedOff).toEqual([])
    expect(status.degraded.map((d) => d.stage)).not.toContain('switches')
  })

  it('reads the CAMERA microphone and the BROKER mute from their own authorities', async () => {
    // These two have no other read path until their own components grow one
    // (D113 phase 3), and `CameraStatus.audio.enabled` is derived from them —
    // dropping them here would silently turn "the operator muted it" back into
    // "the analyzer is dead".
    const status = await makeService(async () =>
      authoritiesWithOff(DEVICE_ID, ['device-audio', 'broker-audio']),
    ).getCameraStatus(DEVICE_ID)
    expect([...status.switchedOff].sort()).toEqual(['broker-audio', 'device-audio'])
  })
})
