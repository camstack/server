/**
 * The pure half of the per-camera function switches.
 *
 * What these guard, in order of what would hurt most:
 *
 *  1. **The group is DERIVED, never hardcoded.** A deployment with no audio
 *     analyzer must not render an audio switch — the roadmap names this as a
 *     rule the repo has broken before.
 *  2. **An unreadable source is never reported as "on".** Guessing produces a
 *     switch the operator believes is on that is not, which is the exact
 *     failure the group exists to remove.
 *  3. **`switchedOff` distinguishes disabled from broken.** A camera with an
 *     empty list producing nothing is broken; one naming a switch was turned
 *     off by a person.
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIO_ANALYSIS_CAP_NAME,
  CAMERA_SWITCH_CATALOG,
  CAMERA_SWITCH_ORDER,
  type CameraSwitchDerivationInput,
  type CameraSwitchId,
  composeSwitchedOff,
  DETECTION_PIPELINE_CAP_NAME,
  deriveCameraSwitches,
  PIPELINE_ANALYTICS_CAP_NAME,
  PRIVACY_MASK_CAP_NAME,
  switchedOffIds,
} from '../camera-switches.js'

/** Everything available and on — the shape a healthy camera resolves to. */
function healthy(patch: Partial<CameraSwitchDerivationInput> = {}): CameraSwitchDerivationInput {
  return {
    deviceId: 101,
    deviceDisabled: false,
    bindableCapNames: [
      DETECTION_PIPELINE_CAP_NAME,
      AUDIO_ANALYSIS_CAP_NAME,
      PIPELINE_ANALYTICS_CAP_NAME,
      'motion-detection',
    ],
    activeWrapperCapNames: [
      DETECTION_PIPELINE_CAP_NAME,
      AUDIO_ANALYSIS_CAP_NAME,
      PIPELINE_ANALYTICS_CAP_NAME,
      'motion-detection',
    ],
    recordingEnabled: true,
    notificationsMuted: false,
    deviceAudio: { supported: true, enabled: true },
    // A camera with zones DRAWN and the mask master off — the state in which
    // the privacy switch is useful, and the only one in which it is offered.
    privacyMask: { supported: true, configuredRegions: 2, enabled: false },
    brokerAudio: { muted: false },
    ...patch,
  }
}

function byId(input: CameraSwitchDerivationInput, id: CameraSwitchId) {
  const found = deriveCameraSwitches(input).find((s) => s.id === id)
  if (!found) throw new Error(`no switch ${id}`)
  return found
}

describe('deriveCameraSwitches', () => {
  it('returns every switch, in catalog order', () => {
    expect(deriveCameraSwitches(healthy()).map((s) => s.id)).toEqual([...CAMERA_SWITCH_ORDER])
  })

  it('reports a healthy camera as all-available, every FUNCTION on', () => {
    for (const s of deriveCameraSwitches(healthy())) {
      // `privacy-mask` is excluded, and the exclusion is the point rather than
      // an exemption: its ON means "the mask is obscuring video", which is not
      // what a healthy camera looks like. Every OTHER row means "this function
      // is doing its job", and those must all be on.
      if (s.id === 'privacy-mask') {
        expect({ id: s.id, available: s.available }).toEqual({ id: s.id, available: true })
        continue
      }
      expect({ id: s.id, available: s.available, enabled: s.enabled }).toEqual({
        id: s.id,
        available: true,
        enabled: true,
      })
    }
  })

  it('every switch carries a non-empty cost line', () => {
    for (const s of deriveCameraSwitches(healthy())) {
      expect(s.costWhenOff.length).toBeGreaterThan(40)
      expect(s.label.length).toBeGreaterThan(0)
    }
  })

  it("recording's cost line names the retention consequence", () => {
    // The only switch whose "off" is destructive-adjacent: footage stays,
    // retention keeps deleting it, nothing new arrives.
    expect(CAMERA_SWITCH_CATALOG.recording.costWhenOff.toLowerCase()).toContain('retention')
  })

  it("object detection's cost line names the downstream loss", () => {
    const line = CAMERA_SWITCH_CATALOG['object-detection'].costWhenOff.toLowerCase()
    expect(line).toContain('events')
    expect(line).toContain('notification')
  })

  // ── 1. derived from the capabilities ───────────────────────────────

  it('offers NO audio switch when audio-analysis is not bindable for the device type', () => {
    const s = byId(
      healthy({
        bindableCapNames: [DETECTION_PIPELINE_CAP_NAME],
        activeWrapperCapNames: [DETECTION_PIPELINE_CAP_NAME],
      }),
      'audio-analysis',
    )
    expect(s.available).toBe(false)
    expect(s.unavailableReason).toBe('no-provider')
  })

  it('offers NO detection switch when detection-pipeline is not bindable', () => {
    const s = byId(
      healthy({
        bindableCapNames: [AUDIO_ANALYSIS_CAP_NAME],
        activeWrapperCapNames: [AUDIO_ANALYSIS_CAP_NAME],
      }),
      'object-detection',
    )
    expect(s.available).toBe(false)
    expect(s.unavailableReason).toBe('no-provider')
  })

  it('still offers the camera switch when nothing else is bindable', () => {
    const s = byId(healthy({ bindableCapNames: [], activeWrapperCapNames: [] }), 'stream-broker')
    expect(s.available).toBe(true)
  })

  // ── 2. an absent binding row is OFF, not missing ────────────────────

  it('reads a deactivated wrapper (row absent from bindings) as OFF, not unavailable', () => {
    // `setWrapperActive({active:false})` REMOVES the row; there is no
    // `active:false` entry to read. Bindable-but-not-bound is the off state.
    const s = byId(
      healthy({ activeWrapperCapNames: [AUDIO_ANALYSIS_CAP_NAME, 'motion-detection'] }),
      'object-detection',
    )
    expect(s.available).toBe(true)
    expect(s.enabled).toBe(false)
  })

  it('reads deviceManager disabled as the camera switch being off', () => {
    expect(byId(healthy({ deviceDisabled: true }), 'stream-broker').enabled).toBe(false)
  })

  it('explains the camera planes of a DISABLED camera as disabled, not unreachable', () => {
    // The orchestrator does not dial a disabled camera, so both planes arrive
    // `null`. Reporting that as `source-unreachable` would tell the operator
    // the provider is broken when they switched the camera off themselves.
    const input = healthy({ deviceDisabled: true, deviceAudio: null, privacyMask: null })
    for (const id of ['device-audio', 'privacy-mask'] as const) {
      const s = byId(input, id)
      expect(s.available).toBe(false)
      expect(s.unavailableReason).toBe('device-disabled')
    }
    // …and the badge does not count the unread planes as unreadable either.
    expect(composeSwitchedOff(input).unreadable).toEqual([])
    expect(composeSwitchedOff(input).switchedOff).toContain('stream-broker')
  })

  it('reads RecordingConfig.enabled=false as the recording switch being off', () => {
    expect(byId(healthy({ recordingEnabled: false }), 'recording').enabled).toBe(false)
  })

  it('reads a per-camera notification mute as the notifications switch being off', () => {
    expect(byId(healthy({ notificationsMuted: true }), 'notifications').enabled).toBe(false)
  })

  // ── the camera's own microphone ──────────────────────────────────────
  //
  // The one switch whose authority is the CAMERA rather than a server-side
  // store. Availability cannot come from `listBindableCapsForDeviceType` —
  // `privacy-mask` is a device-NATIVE cap and carries no wrappers — so it is
  // derived from the cap's own camera-probed `getOptions`.

  it('offers the microphone switch when the camera probe says it is controllable', () => {
    const s = byId(healthy(), 'device-audio')
    expect(s.available).toBe(true)
    expect(s.enabled).toBe(true)
    expect(s.authority).toEqual({ kind: 'camera-audio', capName: PRIVACY_MASK_CAP_NAME })
  })

  it('reads a camera whose microphone is off as the switch being off', () => {
    const s = byId(healthy({ deviceAudio: { supported: true, enabled: false } }), 'device-audio')
    expect(s.available).toBe(true)
    expect(s.enabled).toBe(false)
  })

  it('offers NO microphone switch for a camera whose probe says it has none', () => {
    // A camera with no controllable microphone must not render a dead toggle,
    // and must never be reported as "audio switched off" — nobody switched it.
    const s = byId(healthy({ deviceAudio: { supported: false, enabled: null } }), 'device-audio')
    expect(s.available).toBe(false)
    expect(s.unavailableReason).toBe('no-provider')
  })

  it('offers NO microphone switch when the camera says it supports one but cannot report it', () => {
    // supported-but-unreadable is NOT the same as absent: the control would be
    // rendered against a guessed state, which is the failure the group exists
    // to remove.
    const s = byId(healthy({ deviceAudio: { supported: true, enabled: null } }), 'device-audio')
    expect(s.available).toBe(false)
    expect(s.unavailableReason).toBe('source-unreachable')
  })

  it('the microphone cost line names what stops and what does NOT', () => {
    const line = CAMERA_SWITCH_CATALOG['device-audio'].costWhenOff.toLowerCase()
    expect(line).toContain('silent')
    // Turning the camera's microphone off must not read as "the camera stops".
    expect(line).toContain('video')
  })

  // ── the BROKER's audio plane (D83) ──────────────────────────────────
  //
  // The sibling of `device-audio` and NOT a duplicate of it: that one writes
  // the camera, this one writes the broker's own per-device policy. They
  // cannot disagree because neither reads the other's store, and each is
  // reported separately.

  it('offers the broker-audio switch ON when the broker is distributing audio', () => {
    const s = byId(healthy(), 'broker-audio')
    expect(s.available).toBe(true)
    expect(s.enabled).toBe(true)
    expect(s.authority).toEqual({ kind: 'broker-audio-mute' })
  })

  it('inverts the store: muted broker = switch OFF', () => {
    const s = byId(healthy({ brokerAudio: { muted: true } }), 'broker-audio')
    expect(s.available).toBe(true)
    expect(s.enabled).toBe(false)
  })

  it('offers the broker-audio switch even for a camera with no controllable microphone', () => {
    // The broker mute is a POLICY on distribution, not a mirror of the
    // camera's capability. A camera whose vendor exposes no microphone
    // control is exactly the camera this row exists for.
    const s = byId(
      healthy({ deviceAudio: { supported: false, enabled: null }, brokerAudio: { muted: false } }),
      'broker-audio',
    )
    expect(s.available).toBe(true)
  })

  it('renders NO broker-audio control when the broker node did not answer', () => {
    const s = byId(healthy({ brokerAudio: null }), 'broker-audio')
    expect(s.available).toBe(false)
    expect(s.unavailableReason).toBe('source-unreachable')
  })

  it('the broker-audio cost line says recordings made while muted are silent FOREVER', () => {
    const line = CAMERA_SWITCH_CATALOG['broker-audio'].costWhenOff.toLowerCase()
    expect(line).toContain('forever')
    expect(line).toContain('recorded')
    // …and that the picture is untouched, so an operator can tell this apart
    // from the whole-camera switch.
    expect(line).toContain('camera keeps capturing')
  })

  it('a muted broker is REPORTED off, never merely quiet', () => {
    const off = switchedOffIds(deriveCameraSwitches(healthy({ brokerAudio: { muted: true } })))
    expect(off).toContain('broker-audio')
  })

  it('the two audio rows report independently — one off does not imply the other', () => {
    const both = deriveCameraSwitches(
      healthy({ deviceAudio: { supported: true, enabled: true }, brokerAudio: { muted: true } }),
    )
    expect(both.find((s) => s.id === 'device-audio')?.enabled).toBe(true)
    expect(both.find((s) => s.id === 'broker-audio')?.enabled).toBe(false)
  })

  it('places broker-audio directly BELOW device-audio — the source before its consumer', () => {
    const order = deriveCameraSwitches(healthy()).map((s) => s.id)
    expect(order.indexOf('broker-audio')).toBe(order.indexOf('device-audio') + 1)
    expect(order.indexOf('broker-audio')).toBeLessThan(order.indexOf('audio-analysis'))
  })

  // ── the PRIVACY MASK row: inverted polarity, probe-gated ────────────

  it('offers the mask switch only when zones are actually drawn', () => {
    const s = byId(healthy(), 'privacy-mask')
    expect(s.available).toBe(true)
    expect(s.enabled).toBe(false)
    expect(s.authority).toEqual({ kind: 'camera-mask', capName: PRIVACY_MASK_CAP_NAME })
  })

  it('reads mask ON as the switch being ON — the same polarity HomeKit exposes', () => {
    // `addon-export-hap`'s privacy Switch mirrors `patch.enabled` verbatim. If
    // this inverted, one camera would read "privacy on" in HomeKit and "off"
    // in the app at the same instant.
    const s = byId(
      healthy({ privacyMask: { supported: true, configuredRegions: 1, enabled: true } }),
      'privacy-mask',
    )
    expect(s.enabled).toBe(true)
  })

  it('OFFERS the mask switch with a warning when no zone is drawn', () => {
    // Not `no-provider` and not `source-unreachable`: the camera can do this,
    // there is simply nothing drawn for it to blank yet. The master enable is
    // still a real, persisted camera setting, and this is the entry point to
    // the feature — greying it out on every camera of a fleet that has never
    // drawn a zone says "your cameras cannot do this", which is false.
    const s = byId(
      healthy({ privacyMask: { supported: true, configuredRegions: 0, enabled: false } }),
      'privacy-mask',
    )
    expect(s.available).toBe(true)
    expect(s.unavailableReason).toBeUndefined()
    expect(s.warning).toBe('no-privacy-zones')
  })

  it('carries NO warning once a zone exists', () => {
    const s = byId(
      healthy({ privacyMask: { supported: true, configuredRegions: 2, enabled: true } }),
      'privacy-mask',
    )
    expect(s.available).toBe(true)
    expect(s.warning).toBeUndefined()
  })

  it('an UNREADABLE zone count stays unavailable — unknown is not zero (D315)', () => {
    // The pair this change must not collapse: zero zones is an answer the
    // camera gave, `null` is the absence of one. Offering a toggle on the
    // second would write to a camera nobody could read.
    const s = byId(
      healthy({ privacyMask: { supported: true, configuredRegions: null, enabled: null } }),
      'privacy-mask',
    )
    expect(s.available).toBe(false)
    expect(s.unavailableReason).toBe('source-unreachable')
    expect(s.warning).toBeUndefined()
  })

  it('offers NO mask switch on a model that cannot store zones at all', () => {
    // Reolink answers `maxNum: 0` / `supportedShapes: []` honestly on such
    // models; the service turns that into `supported: false`.
    const s = byId(
      healthy({ privacyMask: { supported: false, configuredRegions: null, enabled: null } }),
      'privacy-mask',
    )
    expect(s.available).toBe(false)
    expect(s.unavailableReason).toBe('no-provider')
  })

  it('offers NO mask switch when the zones are configured but unreadable', () => {
    const s = byId(
      healthy({ privacyMask: { supported: true, configuredRegions: 2, enabled: null } }),
      'privacy-mask',
    )
    expect(s.available).toBe(false)
    expect(s.unavailableReason).toBe('source-unreachable')
  })

  it('NEVER marks the camera switched-off, in either mask position', () => {
    // The load-bearing one. With mask OFF being the ordinary state of nearly
    // every camera, counting it would badge healthy cameras as disabled and
    // bury the badge that matters.
    for (const enabled of [true, false]) {
      const ids = switchedOffIds(
        deriveCameraSwitches(
          healthy({ privacyMask: { supported: true, configuredRegions: 3, enabled } }),
        ),
      )
      expect(ids).not.toContain('privacy-mask')
    }
    // …while a real function switched off still is reported.
    expect(switchedOffIds(deriveCameraSwitches(healthy({ recordingEnabled: false })))).toEqual([
      'recording',
    ])
  })

  it('the mask cost line states BOTH directions, because it is always rendered', () => {
    const line = CAMERA_SWITCH_CATALOG['privacy-mask'].costWhenOff.toLowerCase()
    expect(line).toContain('on:')
    expect(line).toContain('off:')
    // The polarity has to be unmissable — an operator who reads this backwards
    // un-blanks a room believing they blanked it.
    expect(line).toContain('blacked out')
  })

  // ── 3. an unreadable source is never a control ──────────────────────

  it.each([
    ['bindableCapNames', { bindableCapNames: null }, 'object-detection'],
    ['activeWrapperCapNames', { activeWrapperCapNames: null }, 'audio-analysis'],
    ['recordingEnabled', { recordingEnabled: null }, 'recording'],
    ['notificationsMuted', { notificationsMuted: null }, 'notifications'],
    ['deviceAudio', { deviceAudio: null }, 'device-audio'],
    ['privacyMask', { privacyMask: null }, 'privacy-mask'],
    ['brokerAudio', { brokerAudio: null }, 'broker-audio'],
  ] as const)('an unreadable %s yields available:false, never a defaulted control', (_name, patch, id) => {
    const s = byId(healthy(patch), id)
    expect(s.available).toBe(false)
    expect(s.unavailableReason).toBe('source-unreachable')
  })

  // ── authority — where the state lives ───────────────────────────────

  it('routes each switch to the authority that already owned the state', () => {
    const authorities = Object.fromEntries(
      deriveCameraSwitches(healthy()).map((s) => [s.id, s.authority]),
    )
    expect(authorities['stream-broker']).toEqual({ kind: 'device-disabled' })
    expect(authorities['object-detection']).toEqual({
      kind: 'wrapper-binding',
      capName: DETECTION_PIPELINE_CAP_NAME,
    })
    expect(authorities['audio-analysis']).toEqual({
      kind: 'wrapper-binding',
      capName: AUDIO_ANALYSIS_CAP_NAME,
    })
    expect(authorities['recording']).toEqual({ kind: 'recording-config' })
    expect(authorities['notifications']).toEqual({ kind: 'notification-mute' })
    expect(authorities['device-audio']).toEqual({
      kind: 'camera-audio',
      capName: PRIVACY_MASK_CAP_NAME,
    })
    // No capName: the broker's own store, not a cap bound to the device.
    expect(authorities['broker-audio']).toEqual({ kind: 'broker-audio-mute' })
  })
})

describe('switchedOffIds', () => {
  it('is empty for a healthy camera — a camera producing nothing here is BROKEN', () => {
    expect(switchedOffIds(deriveCameraSwitches(healthy()))).toEqual([])
  })

  it('names the switches an operator turned off', () => {
    const off = switchedOffIds(
      deriveCameraSwitches(
        healthy({
          activeWrapperCapNames: [AUDIO_ANALYSIS_CAP_NAME],
          recordingEnabled: false,
        }),
      ),
    )
    // Unbinding the analytics wrapper takes event saving with it — one read,
    // every wrapper-backed switch.
    expect([...off].sort()).toEqual(['event-saving', 'object-detection', 'recording'])
  })

  it('never reports an UNAVAILABLE switch as switched off', () => {
    // Nobody turned off a function no provider offers; reporting it would put
    // a permanent "audio off" badge on a camera that never had audio.
    //
    // Built by hand rather than derived: `deriveCameraSwitches` already leaves
    // `enabled: true` on an unavailable switch, so a derived fixture would
    // pass with or without the availability filter — the assertion has to
    // present the one combination that discriminates.
    const off = switchedOffIds([
      {
        id: 'audio-analysis',
        label: 'Audio',
        costWhenOff: 'x',
        available: false,
        unavailableReason: 'no-provider',
        enabled: false,
        authority: { kind: 'wrapper-binding', capName: AUDIO_ANALYSIS_CAP_NAME },
      },
      {
        id: 'recording',
        label: 'Recording',
        costWhenOff: 'x',
        available: true,
        enabled: false,
        authority: { kind: 'recording-config' },
      },
    ])
    expect(off).toEqual(['recording'])
  })
})

/**
 * `composeSwitchedOff` — the badge, recomposed straight from the authorities.
 *
 * This is the half that OUTLIVES the switch group (D113). `deriveCameraSwitches`
 * exists to paint a control panel: labels, cost lines, `available`. The badge
 * needs none of that — it needs to know which functions a person turned off and
 * whether the answer is complete. Once the aggregate cap is gone, this is the
 * only thing `CameraStatus.switchedOff` is built from, so it is pinned
 * separately rather than through the group it will outlive.
 *
 * The rule these guard is the 2026-08-08 incident: `switchedOff: []` was
 * returned for a camera whose `stream-broker` AND `recording` the operator had
 * switched off, and the camera read as BROKEN. An empty list is only a positive
 * claim when `unreadable` is empty too.
 */
describe('composeSwitchedOff', () => {
  it('reports nothing off, and nothing unreadable, for a healthy camera', () => {
    expect(composeSwitchedOff(healthy())).toEqual({ switchedOff: [], unreadable: [] })
  })

  it('names every function a person switched off, straight off its own authority', () => {
    const composed = composeSwitchedOff(
      healthy({
        deviceDisabled: true,
        activeWrapperCapNames: [DETECTION_PIPELINE_CAP_NAME],
        recordingEnabled: false,
        notificationsMuted: true,
        deviceAudio: { supported: true, enabled: false },
        brokerAudio: { muted: true },
      }),
    )
    expect([...composed.switchedOff].sort()).toEqual([
      'audio-analysis',
      'broker-audio',
      'device-audio',
      'event-saving',
      'notifications',
      'recording',
      'stream-broker',
    ])
    expect(composed.unreadable).toEqual([])
  })

  it('agrees with the group it will outlive — same input, same ids', () => {
    // The two derivations must not drift while both exist. When the group goes,
    // this assertion goes with it and the one above stays.
    const input = healthy({ recordingEnabled: false, notificationsMuted: true })
    expect(composeSwitchedOff(input).switchedOff).toEqual(
      switchedOffIds(deriveCameraSwitches(input)),
    )
  })

  it('names the authority that did NOT answer, and never counts it as off', () => {
    // The whole point. `recordingEnabled: null` is "we could not read the
    // recorder", which is not "the operator turned recording off" and is not
    // "recording is on" either.
    const composed = composeSwitchedOff(healthy({ recordingEnabled: null }))
    expect(composed.switchedOff).toEqual([])
    expect(composed.unreadable).toEqual(['recording'])
  })

  it('an unreadable authority makes the list a FLOOR — the reals still show', () => {
    const composed = composeSwitchedOff(
      healthy({ recordingEnabled: null, notificationsMuted: true }),
    )
    expect(composed.switchedOff).toEqual(['notifications'])
    expect(composed.unreadable).toEqual(['recording'])
  })

  it('a function no provider offers is neither off nor unreadable', () => {
    // Nobody switched off a function this deployment does not have. Reporting
    // it either way would put a permanent badge on a camera that never had it.
    const composed = composeSwitchedOff(
      healthy({
        bindableCapNames: [DETECTION_PIPELINE_CAP_NAME],
        activeWrapperCapNames: [DETECTION_PIPELINE_CAP_NAME],
      }),
    )
    expect(composed.switchedOff).toEqual([])
    expect(composed.unreadable).toEqual([])
  })

  it('a bindings read that failed makes EVERY wrapper function unreadable', () => {
    // Every wrapper-backed switch shares one read, so they fail together — and
    // the list is derived, not spelled: a switch added to the catalog appears
    // here without this test being touched, which is the point of asserting it
    // against the catalog rather than against three names.
    const composed = composeSwitchedOff(
      healthy({ bindableCapNames: null, activeWrapperCapNames: null }),
    )
    const wrapperIds = CAMERA_SWITCH_ORDER.filter(
      (id) => CAMERA_SWITCH_CATALOG[id].authority.kind === 'wrapper-binding',
    )
    expect(composed.switchedOff).toEqual([])
    expect([...composed.unreadable].sort()).toEqual([...wrapperIds].sort())
  })

  it('names event-saving when analytics is unbound — the timeline stops, the camera looks busy', () => {
    // The gap this row exists for: detection on, live boxes moving, nothing
    // written. Without it an operator sees a healthy camera with an empty
    // history and has nowhere to look.
    const composed = composeSwitchedOff(
      healthy({
        activeWrapperCapNames: [DETECTION_PIPELINE_CAP_NAME, AUDIO_ANALYSIS_CAP_NAME],
      }),
    )
    expect(composed.switchedOff).toContain('event-saving')
    expect(composed.switchedOff).not.toContain('object-detection')
  })

  it('never names privacy-mask — in EITHER position, readable or not', () => {
    // Its ON means "the mask is obscuring video", not "the function works", so
    // the ordinary unmasked camera would otherwise carry a permanent badge.
    const drawn = composeSwitchedOff(
      healthy({ privacyMask: { supported: true, configuredRegions: 2, enabled: false } }),
    )
    expect(drawn.switchedOff).not.toContain('privacy-mask')
    const unreadable = composeSwitchedOff(healthy({ privacyMask: null }))
    expect(unreadable.switchedOff).not.toContain('privacy-mask')
    expect(unreadable.unreadable).not.toContain('privacy-mask')
  })

  it('a camera with NO microphone is not a camera whose microphone is off', () => {
    const composed = composeSwitchedOff(
      healthy({ deviceAudio: { supported: false, enabled: null } }),
    )
    expect(composed.switchedOff).toEqual([])
    expect(composed.unreadable).toEqual([])
  })

  it('a microphone the camera could not report is UNREADABLE, never on', () => {
    const composed = composeSwitchedOff(
      healthy({ deviceAudio: { supported: true, enabled: null } }),
    )
    expect(composed.switchedOff).toEqual([])
    expect(composed.unreadable).toEqual(['device-audio'])
  })

  it('a broker node that did not answer is UNREADABLE, never "audio flows"', () => {
    const composed = composeSwitchedOff(healthy({ brokerAudio: null }))
    expect(composed.switchedOff).toEqual([])
    expect(composed.unreadable).toEqual(['broker-audio'])
  })

  it('returns ids in catalog order, so two surfaces render the same badge', () => {
    const composed = composeSwitchedOff(
      healthy({
        deviceDisabled: true,
        recordingEnabled: false,
        activeWrapperCapNames: [AUDIO_ANALYSIS_CAP_NAME],
      }),
    )
    // Order is the catalog's, not the input's: event saving sits between the
    // analysers that feed it and the recording that consumes what it writes.
    expect(composed.switchedOff).toEqual([
      'stream-broker',
      'object-detection',
      'event-saving',
      'recording',
    ])
  })
})
