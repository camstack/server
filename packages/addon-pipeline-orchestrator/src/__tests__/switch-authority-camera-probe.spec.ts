/**
 * What ONE open admin page costs, and what it is allowed to remember
 * (`switch-authorities.ts`).
 *
 * `getCameraStatuses` composes `CameraStatus.switchedOff` for every camera, and
 * the admin Cameras page polls it every 5 seconds. Seven of the eight
 * authorities behind that badge are in-hub reads costing 5–15ms. The eighth
 * reaches the camera's provider.
 *
 * On 2026-08-21 the live hub logged **337 WARN lines in one minute** from about
 * five of those polls — 158 of them for `recording.getDeviceConfig`, a source
 * that answers in 9ms when it is not queued behind 58 camera round trips.
 *
 * The camera round trips are gone, but **not because this module remembers
 * anything**. It briefly did, and that was wrong twice over: the mask editor
 * writes `privacyMask.setMask` straight to the cap and never through this
 * server, so the copy kept here outlived the fact the moment an operator used
 * the very control the badge describes. The freshness now lives in the
 * provider's runtime-state bridge, where every write already lands
 * (`OPERATOR_WRITTEN_STALE_MS` + `serve-and-revalidate`, D221) — and the
 * per-poll dial count is pinned there, in
 * `packages/types/src/device/__tests__/runtime-state-helpers.spec.ts`.
 *
 * So what this file pins is what remains true HERE:
 *  - the privacy pair is a READ-THROUGH — a change at the camera is visible on
 *    the very next poll, with nothing to invalidate;
 *  - a source that stalls is bounded and nulls only its OWN field;
 *  - a repeating fault leaves a bounded record, the first line in full and
 *    tagged with the numeric deviceId, because every question asked of it is
 *    per-camera.
 */
import type { IScopedLogger, PrivacyMaskRegion } from '@camstack/types'
import { deriveCameraSwitches, PRIVACY_MASK_CAP_NAME } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RepeatWarnSampler } from '../repeat-warn-sampler.js'
import { readSwitchAuthorities, type SwitchAuthorityReadDeps } from '../switch-authorities.js'

/** One `logger.warn`, so a test can assert the line AND its `deviceId` tag. */
interface Warning {
  readonly message: string
  readonly tags: Record<string, unknown> | undefined
  readonly meta: Record<string, unknown> | undefined
}

interface Recorder {
  readonly calls: string[]
  readonly warnings: Warning[]
}

function makeLogger(warnings: Warning[]): IScopedLogger {
  const noop = (): void => undefined
  const logger = {
    debug: noop,
    info: noop,
    error: noop,
    trace: noop,
    warn: (message: string, ctx?: unknown): void => {
      const rec: Record<string, unknown> = ctx === undefined ? {} : { ...(ctx as object) }
      const tags = rec['tags']
      const meta = rec['meta']
      warnings.push({
        message,
        tags: typeof tags === 'object' && tags !== null ? { ...tags } : undefined,
        meta: typeof meta === 'object' && meta !== null ? { ...meta } : undefined,
      })
    },
    child: (): unknown => logger,
  }
  return logger as never
}

/** How the camera's provider misbehaves in a given test. */
type CameraFault = 'none' | 'hang' | 'unreachable'

/** What the camera currently reports, so a test can change it mid-run. */
interface CameraState {
  /** `null` = the camera never answered — the cap's own "unknown". */
  audioEnabled: boolean | null
  /** `deviceManager` soft-disable; the default is a camera in service. */
  disabled?: boolean
  /**
   * What `getStatus` reports for the VIDEO plane. `null` is the cap's cold
   * slice — "this camera has not been reached" — and is NOT the empty list.
   */
  regions?: readonly PrivacyMaskRegion[] | null
}

/**
 * The hub api, narrowed to what `readSwitchAuthorities` touches. The two faults
 * are the live shapes: a provider that answers too late (what the 1.2s bound
 * exists for) and one that refuses outright.
 */
function makeApi(rec: Recorder, fault: CameraFault, camera: CameraState): never {
  const q = <T>(method: string, fn: () => T) => ({
    query: async (): Promise<T> => {
      rec.calls.push(method)
      if (fault !== 'none' && method.startsWith('privacyMask.')) {
        if (fault === 'unreachable') throw new Error('camera unreachable')
        await new Promise((resolve) => {
          // Unref'd: the read gives up at its own bound and the process must
          // not be held open by a camera that never answers.
          setTimeout(resolve, 5_000).unref()
        })
      }
      return fn()
    },
  })
  const api = {
    deviceManager: {
      getDevice: q('getDevice', () => ({
        id: 101,
        type: 'camera',
        disabled: camera.disabled ?? false,
      })),
      listBindableCapsForDeviceType: q('listBindableCapsForDeviceType', () => [
        { capName: 'detection-pipeline', wrappers: ['detection-pipeline'] },
      ]),
      getBindings: q('getBindings', () => ({
        deviceId: 101,
        entries: [
          {
            capName: 'detection-pipeline',
            kind: 'wrapped' as const,
            providerAddonId: 'detection-pipeline',
            providerNodeId: 'hub',
            nativeAddonId: '',
          },
          {
            capName: PRIVACY_MASK_CAP_NAME,
            kind: 'native' as const,
            providerAddonId: '',
            providerNodeId: 'hub',
            nativeAddonId: 'provider-wyze',
          },
        ],
      })),
    },
    recordingArchive: {
      getDeviceConfig: q('recordingArchive.getDeviceConfig', () => ({
        enabled: true,
        bands: [],
      })),
    },
    notificationRules: {
      listDeviceMutes: q('notificationRules.listDeviceMutes', () => ({
        mutedDeviceIds: [],
      })),
    },
    streamBroker: {
      getDeviceAudioMute: q('streamBroker.getDeviceAudioMute', () => ({
        muted: false,
      })),
    },
    privacyMask: {
      getOptions: q('privacyMask.getOptions', () => ({
        maxRegions: 4,
        supportedShapes: ['rect'],
        supportsAudioMute: true,
      })),
      getStatus: q('privacyMask.getStatus', () => ({
        enabled: false,
        regions: camera.regions === undefined ? [] : camera.regions,
        audioEnabled: camera.audioEnabled,
      })),
    },
  }
  return api as never
}

function makeDeps(warnings: Warning[], sampler: RepeatWarnSampler): SwitchAuthorityReadDeps {
  return {
    logger: makeLogger(warnings),
    assignSource: () => 'hub',
    warnSampler: sampler,
  }
}

describe('readSwitchAuthorities — a polled page holds NO state of its own', () => {
  it('shows a camera-side change on the very next poll', async () => {
    const rec: Recorder = { calls: [], warnings: [] }
    let t = 1_000_000
    const deps = makeDeps(rec.warnings, new RepeatWarnSampler(60_000, () => t))
    const camera: CameraState = { audioEnabled: true }

    const before = await readSwitchAuthorities(makeApi(rec, 'none', camera), 101, deps)
    expect(before.derivation.deviceAudio).toEqual({ supported: true, enabled: true })

    // The mask editor writes the cap DIRECTLY — it never passes through this
    // server. A cache here would have nothing to invalidate and would keep
    // reporting the microphone the operator just muted as live.
    camera.audioEnabled = false
    t += 5_000

    const after = await readSwitchAuthorities(makeApi(rec, 'none', camera), 101, deps)
    expect(after.derivation.deviceAudio).toEqual({ supported: true, enabled: false })
  })

  it('keeps every cheap authority LIVE on every poll', async () => {
    const rec: Recorder = { calls: [], warnings: [] }
    let t = 1_000_000
    const deps = makeDeps(rec.warnings, new RepeatWarnSampler(60_000, () => t))
    const camera: CameraState = { audioEnabled: true }

    for (let i = 0; i < 12; i += 1) {
      await readSwitchAuthorities(makeApi(rec, 'none', camera), 101, deps)
      t += 5_000
    }

    // This must never become a cache over everything, or an operator's
    // recording toggle would go unseen on the very page that shows it.
    expect(rec.calls.filter((c) => c === 'recordingArchive.getDeviceConfig')).toHaveLength(12)
    expect(rec.calls.filter((c) => c === 'getBindings')).toHaveLength(12)
  })

  it('nulls ONLY the stalled source, and still answers the other seven', async () => {
    const rec: Recorder = { calls: [], warnings: [] }
    let t = 1_000_000
    const deps = makeDeps(rec.warnings, new RepeatWarnSampler(60_000, () => t))

    const reads = await readSwitchAuthorities(
      makeApi(rec, 'hang', { audioEnabled: true }),
      101,
      deps,
    )

    // A source that did not answer is UNKNOWN, never a value defaulted to "on".
    expect(reads.derivation.deviceAudio).toBeNull()
    expect(reads.derivation.privacyMask).toBeNull()
    // …and the seven that DID answer are untouched — one slow source must not
    // consume the budget of the ones already back.
    expect(reads.derivation.recordingEnabled).toBe(true)
    expect(reads.derivation.deviceDisabled).toBe(false)
    expect(reads.derivation.brokerAudio).toEqual({ muted: false })
  })

  it('records a repeating fault once, with a bounded summary — not once per poll', async () => {
    const rec: Recorder = { calls: [], warnings: [] }
    let t = 1_000_000
    const deps = makeDeps(rec.warnings, new RepeatWarnSampler(60_000, () => t))

    for (let i = 0; i < 6; i += 1) {
      await readSwitchAuthorities(makeApi(rec, 'unreachable', { audioEnabled: true }), 101, deps)
      t += 5_000
    }

    const failed = rec.warnings.filter((w) => w.meta?.['source'] === 'privacyMask.getStatus')
    // Six polls used to be six identical lines per source per camera. One
    // example is what makes the finding actionable; the rest are a counter.
    expect(failed.length).toBeLessThanOrEqual(2)
    expect(failed[0]?.tags).toEqual({ deviceId: 101 })
  })

  it('never dials a DISABLED camera — its planes are unknown, not stalled', async () => {
    const rec: Recorder = { calls: [], warnings: [] }
    let t = 1_000_000
    const deps = makeDeps(rec.warnings, new RepeatWarnSampler(60_000, () => t))

    // A camera the operator switched off has no session, and its provider
    // waits the full 1.2s bound on both planes, every poll, for a switch the
    // panel would not offer anyway. On 2026-09-05 that was the only authority
    // timeout left on the hub (device 105), twice per poll, for a day.
    const reads = await readSwitchAuthorities(
      makeApi(rec, 'hang', { audioEnabled: true, disabled: true }),
      101,
      deps,
    )

    expect(reads.derivation.deviceDisabled).toBe(true)
    expect(rec.calls.filter((c) => c.startsWith('privacyMask.'))).toEqual([])
    expect(rec.warnings).toEqual([])
    // Unknown, honestly: nobody asked the camera. Never a plane defaulted on.
    expect(reads.derivation.deviceAudio).toBeNull()
    expect(reads.derivation.privacyMask).toBeNull()
    // The cheap in-hub authorities are still read: the badge needs them.
    expect(reads.derivation.recordingEnabled).toBe(true)
    expect(reads.derivation.brokerAudio).toEqual({ muted: false })
  })

  it('a camera that has not ANSWERED does not report "nothing to mask" (D315)', async () => {
    const rec: Recorder = { calls: [], warnings: [] }
    let t = 1_000_000
    const deps = makeDeps(rec.warnings, new RepeatWarnSampler(60_000, () => t))

    // The provider's cold slice: `regions: null` (never reached — a battery
    // camera asleep behind `sleepGatedRefresh` stays here for days) and
    // `audioEnabled: null` on the same payload. Both planes come from ONE
    // refresh, so they must reach the same verdict.
    const reads = await readSwitchAuthorities(
      makeApi(rec, 'none', { audioEnabled: null, regions: null }),
      101,
      deps,
    )

    // `configuredRegions` is the field that carries the unknown here: the cold
    // sentinel's `enabled: false` is a value, not an answer, and the
    // derivation must not reach it.
    expect(reads.derivation.privacyMask?.supported).toBe(true)
    expect(reads.derivation.privacyMask?.configuredRegions).toBeNull()

    const mask = deriveCameraSwitches(reads.derivation).find((s) => s.id === 'privacy-mask')
    // The `no-privacy-zones` warning tells the operator to go and draw a
    // zone. Saying that about a camera nobody could reach sends them to check
    // a mask that may already be there — and the toggle beside it would write
    // to a camera whose state nobody can see.
    expect(mask?.available).toBe(false)
    expect(mask?.unavailableReason).toBe('source-unreachable')
  })

  it('a camera that ANSWERED with no zones gets the switch, with a warning', async () => {
    const rec: Recorder = { calls: [], warnings: [] }
    let t = 1_000_000
    const deps = makeDeps(rec.warnings, new RepeatWarnSampler(60_000, () => t))

    // The other side of the same coin: `[]` is a real answer. The control is
    // offered and carries the warning that names the missing thing. On the
    // reference fleet this is EVERY camera — none has a privacy zone drawn,
    // which is exactly why withholding it made the feature look absent.
    const reads = await readSwitchAuthorities(
      makeApi(rec, 'none', { audioEnabled: true, regions: [] }),
      101,
      deps,
    )

    const mask = deriveCameraSwitches(reads.derivation).find((s) => s.id === 'privacy-mask')
    expect(mask?.available).toBe(true)
    expect(mask?.warning).toBe('no-privacy-zones')
  })
})
