/**
 * `CameraStatus.audio.enabled` must reflect the OPERATOR'S SWITCH.
 *
 * It used to be a hardcoded `true` returned whenever an audio node assignment
 * existed (`camera-status-service.ts`: `return audioNodeId ? { nodeId,
 * enabled: true } : null`). So a camera whose operator had turned audio off
 * reported `audio.enabled: true` and produced no audio labels — identical, on
 * every surface, to a camera whose analyzer had died.
 *
 * That is exactly the "a disabled function must be visible as DISABLED, not
 * merely quiet" rule, broken in the very block the switch group has to agree
 * with. This test exists because the end-to-end spec could not reach it: the
 * audio block is only present once an audio node is ASSIGNED, and an assertion
 * guarded by `if (status.audio !== null)` would have passed against the lie.
 */
import type {
  AddonApi,
  CameraSwitchId,
  IScopedLogger,
  PipelineAssignment,
  RunnerCameraConfig,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { CameraStatusService } from '../camera-status-service.js'
import type { AudioNodeAssignment } from '../orchestrator-types.js'
import { RepeatWarnSampler } from '../repeat-warn-sampler.js'
import { authoritiesWithOff } from './camera-status-switch-authorities.js'

const AUDIO_ASSIGNMENT: AudioNodeAssignment = {
  deviceId: 101,
  nodeId: 'hub',
  pinned: false,
  assignedAt: 0,
}

const SILENT_LOGGER: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: (): IScopedLogger => SILENT_LOGGER,
  withTags: (): IScopedLogger => SILENT_LOGGER,
}

/**
 * Every remote stage degrades to `null` with no api, which is what we want:
 * the audio block is orchestrator-local and is composed regardless.
 */
function makeService(switchedOff: readonly CameraSwitchId[]): CameraStatusService {
  return new CameraStatusService({
    api: (): AddonApi => null as never,
    logger: SILENT_LOGGER,
    warnSampler: new RepeatWarnSampler(),
    getAssignment: (): PipelineAssignment | null => null,
    getAudioAssignment: (): AudioNodeAssignment | null => AUDIO_ASSIGNMENT,
    getCameraConfig: (): RunnerCameraConfig | null => null,
    hasCameraConfig: (): boolean => true,
    getPendingReason: (): string | undefined => undefined,
    assignSource: (): string => 'hub',
    listAssignedDeviceIds: (): readonly number[] => [101],
    isSessionCamera: (): boolean => false,
    // RAW AUTHORITY READS, not a derived group — the service composes the
    // badge itself via `composeSwitchedOff`. The fake never hands over a
    // pre-filtered list: that is what would let it supply the value production
    // forgot to fetch, and it is how D83 could have been hidden here — the two
    // audio switches added since would have been dropped by the fake while the
    // block reported `enabled: true` and the test stayed green.
    switchAuthoritiesFor: async () => authoritiesWithOff(101, switchedOff),
    cameraSensorsFor: () => ({ state: 'not-configured' }),
  })
}

describe('CameraStatus.audio.enabled', () => {
  it('is TRUE when the audio switch is on', async () => {
    const status = await makeService([]).getCameraStatus(101)
    expect(status.audio).toEqual({ nodeId: 'hub', enabled: true })
  })

  it('is FALSE when the operator switched audio off — disabled, not broken', async () => {
    const status = await makeService(['audio-analysis']).getCameraStatus(101)
    expect(status.audio).toEqual({ nodeId: 'hub', enabled: false })
    expect(status.switchedOff).toEqual(['audio-analysis'])
  })

  // ── D83: three switches can silence this block, not one ─────────────

  it('is FALSE when the CAMERA microphone is off — the analyzer has nothing', async () => {
    const status = await makeService(['device-audio']).getCameraStatus(101)
    expect(status.audio).toEqual({ nodeId: 'hub', enabled: false })
  })

  it('is FALSE when the BROKER is not distributing audio', async () => {
    const status = await makeService(['broker-audio']).getCameraStatus(101)
    expect(status.audio).toEqual({ nodeId: 'hub', enabled: false })
  })

  it('is TRUE for an unrelated switch being off — the list is not "anything off"', async () => {
    // Guards the opposite mistake: reporting audio broken because recording
    // or object detection happens to be off would be its own lie.
    const status = await makeService(['recording', 'object-detection']).getCameraStatus(101)
    expect(status.audio).toEqual({ nodeId: 'hub', enabled: true })
  })

  it('the audio block stays absent when no audio node is assigned', async () => {
    const service = new CameraStatusService({
      api: (): AddonApi => null as never,
      logger: SILENT_LOGGER,
      warnSampler: new RepeatWarnSampler(),
      getAssignment: (): PipelineAssignment | null => null,
      getAudioAssignment: (): AudioNodeAssignment | null => null,
      getCameraConfig: (): RunnerCameraConfig | null => null,
      hasCameraConfig: (): boolean => true,
      getPendingReason: (): string | undefined => undefined,
      assignSource: (): string => 'hub',
      listAssignedDeviceIds: (): readonly number[] => [101],
      isSessionCamera: (): boolean => false,
      switchAuthoritiesFor: async () => authoritiesWithOff(101, []),
      cameraSensorsFor: () => ({ state: 'not-configured' }),
    })
    expect((await service.getCameraStatus(101)).audio).toBeNull()
  })
})
