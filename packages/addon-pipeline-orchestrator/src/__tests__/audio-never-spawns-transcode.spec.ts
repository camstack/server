/**
 * The controller half of "an audio-only consumer never causes a video
 * transcode": the stream the subscription actually PROBES and ATTACHES to.
 *
 * Before this rule, `subscribeAudioStream` read
 * `config.audioStreamId ?? config.motionStreamId`, and on this fleet
 * `motionStreamId` is the `low` rung — a broker-spawned `derived:mid-to-low`
 * transcode. The audio subscription counts as broker demand
 * (`StreamBroker.hasLiveIntent()` reads `audioChunkPlane.subscriberCount`) and
 * the derived feeder is spawned/torn down on exactly that demand edge
 * (`attachDerivedFeeder` → `onDemandChange`), so an audio-only listener held an
 * ffmpeg video re-encode open for the whole time it listened.
 *
 * The probe call is the observable: it is made against the stream the
 * subscription has chosen, one step before the attach.
 */
import type { CameraDetectionConfig, CamProfile, IScopedLogger, LogExtras } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  AudioSubscriptionController,
  type AudioSubscriptionControllerDeps,
} from '../audio-subscription-controller.js'
import { makeFakeContext, makeLocalEventBus } from './e2e-helpers.js'

const DEVICE_ID = 108
const DERIVED_LOW = 'derived:mid-to-low'
const NATIVE_MID = 'native:sub'
const NATIVE_HIGH = 'native:main'

interface RecordedLine {
  readonly message: string
  readonly extras: LogExtras | undefined
}

function makeRecordingLogger() {
  const lines: RecordedLine[] = []
  const push = (message: string, extras?: LogExtras): void => {
    lines.push({ message, extras })
  }
  const logger: IScopedLogger = {
    debug: push,
    info: push,
    error: push,
    warn: push,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

function makeConfig(): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['analyzer'],
    // The motion pipeline keeps its derived low rung — that is a VIDEO
    // consumer's choice and nothing here touches it.
    motionStreamId: DERIVED_LOW,
    detectionStreamId: NATIVE_HIGH,
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: 10_000,
    detectionMode: 'always-on',
    audioMode: 'always-on',
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 30,
    occupancyRecheckFrames: 4,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
  }
}

function makeHarness(assigned: ReadonlyMap<CamProfile, string> | null) {
  const { ctx } = makeFakeContext()
  const api = ctx.api
  if (!api) throw new Error('fake context has no api')
  // No audio-analysis provider is registered, so `resolveDeviceSettings`
  // answers `null` and the subscribe stops one step past the probe gate —
  // enough to observe which stream was chosen without a live poller.
  const settingsRead = vi.spyOn(api.audioAnalysis.resolveDeviceSettings, 'query')
  const { logger, lines } = makeRecordingLogger()
  const { bus } = makeLocalEventBus()
  const probed: string[] = []

  const deps: AudioSubscriptionControllerDeps = {
    api: () => api,
    eventBus: bus,
    logger,
    readDeviceStore: async () => ({}),
    probeAudioTrack: async (_deviceId: number, camStreamId: string) => {
      probed.push(camStreamId)
      return { kind: 'present', codec: 'AAC' }
    },
    assignedProfiles: async () => assigned,
    ingestNode: () => 'hub',
    localNodeId: () => 'hub',
    enabledAudioNodes: () => ['hub'],
    audioNodeRole: () => 'hub',
    isAudioAnalysisActive: async () => true,
    isDetectionActive: () => true,
    getActiveDetectionConfig: () => undefined,
    getLedgerConfig: () => null,
    scheduleReconcile: () => undefined,
  }

  return { controller: new AudioSubscriptionController(deps), lines, settingsRead, probed }
}

describe('AudioSubscriptionController — an audio-only consumer never causes a video transcode', () => {
  it('attaches to the native mid rung, not to the derived low the motion pipeline uses', async () => {
    const h = makeHarness(
      new Map<CamProfile, string>([
        ['low', DERIVED_LOW],
        ['mid', NATIVE_MID],
        ['high', NATIVE_HIGH],
      ]),
    )

    await h.controller.resubscribe(DEVICE_ID, makeConfig())

    expect(h.probed).toEqual([NATIVE_MID])
    expect(h.probed).not.toContain(DERIVED_LOW)
    expect(h.settingsRead).toHaveBeenCalled()

    const chosen = h.lines.find((l) => l.message.includes('audio stream selected'))
    expect(chosen?.extras?.tags?.deviceId).toBe(DEVICE_ID)
    expect(chosen?.extras?.meta).toMatchObject({
      camStreamId: NATIVE_MID,
      selectedBy: 'lowest-native-rung',
      profile: 'mid',
    })
  })

  it('REFUSES, loudly, when every rung is derived — it never spawns the transcode', async () => {
    const h = makeHarness(
      new Map<CamProfile, string>([
        ['low', DERIVED_LOW],
        ['mid', 'derived:high-to-mid'],
      ]),
    )

    await h.controller.resubscribe(DEVICE_ID, makeConfig())

    // Nothing was probed and nothing was attached: no broker demand was ever
    // raised, so no feeder can be spawned on our account.
    expect(h.probed).toEqual([])
    expect(h.settingsRead).not.toHaveBeenCalled()
    expect(h.controller.subscriptionsSnapshot.has(DEVICE_ID)).toBe(false)

    const refusal = h.lines.find((l) => l.message.toLowerCase().includes('refus'))
    expect(refusal).toBeDefined()
    expect(refusal?.extras?.tags?.deviceId).toBe(DEVICE_ID)
    expect(JSON.stringify(refusal?.extras?.meta)).toContain('all-rungs-derived')
  })

  it('honours an explicit operator pick verbatim — a derived rung included', async () => {
    const h = makeHarness(
      new Map<CamProfile, string>([
        ['low', DERIVED_LOW],
        ['mid', NATIVE_MID],
      ]),
    )

    await h.controller.resubscribe(DEVICE_ID, { ...makeConfig(), audioStreamPick: 'low' })

    expect(h.probed).toEqual([DERIVED_LOW])
    const chosen = h.lines.find((l) => l.message.includes('audio stream selected'))
    expect(chosen?.extras?.meta).toMatchObject({
      camStreamId: DERIVED_LOW,
      selectedBy: 'operator-pick',
      derived: true,
      pick: 'low',
    })
  })

  it('an ABSENT pick is `auto` — a camera nobody configured behaves as it always did', async () => {
    const h = makeHarness(new Map<CamProfile, string>([['low', 'native:third']]))

    await h.controller.resubscribe(DEVICE_ID, makeConfig())

    expect(h.probed).toEqual(['native:third'])
  })

  it('REFUSES a pick naming a rung this camera no longer publishes, naming the stored value', async () => {
    const h = makeHarness(new Map<CamProfile, string>([['mid', NATIVE_MID]]))

    await h.controller.resubscribe(DEVICE_ID, { ...makeConfig(), audioStreamPick: 'high' })

    expect(h.probed).toEqual([])
    expect(h.controller.subscriptionsSnapshot.has(DEVICE_ID)).toBe(false)
    const refusal = h.lines.find((l) => l.message.toLowerCase().includes('refus'))
    expect(refusal?.extras?.meta).toMatchObject({ reason: 'pick-unassigned', pick: 'high' })
  })
})
