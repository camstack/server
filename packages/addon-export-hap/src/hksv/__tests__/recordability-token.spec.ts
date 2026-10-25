/**
 * Whether a camera CAN record belongs in the export fingerprint.
 *
 * ## The defect
 *
 * The accessory is built once. If `cameraStreams.getProfileRtspEntries` is not
 * readable yet — at boot, before the vendor provider has finished probing —
 * HKSV is withheld with `no-enabled-stream` and the outcome is recorded. The
 * profiles then arrive, and nothing happens: the fingerprint that decides
 * whether to rebuild is `canonicalDeviceFingerprint({deviceId, deviceType,
 * features})`, which the profiles are not part of, so the reconcile that fires
 * on `DeviceReady` finds it unchanged and no-ops. **The withheld decision
 * stands for ever.**
 *
 * Measured on 592 on 2026-09-21: three enabled H.264 profiles live —
 * 3840×2160, 896×512, 640×360 — and an availability reason still reading
 * *"no-enabled-stream: the camera has no enabled RTSP profile"*. 101, whose
 * profiles were ready when its accessory was built, records fine.
 *
 * The operator's question was the right one: *"il profilo RTSP non dovrebbe
 * essere selezionato automaticamente dal plugin?"* — it is, and
 * `pickRecordingSource` does it well. The defect was never the choice. It was
 * that the choice is made once, too early, and never revisited.
 *
 * ## Why a token and not a boolean
 *
 * The SLOT matters, not just "some slot exists": a camera that gains a bigger
 * copyable profile should rebuild onto it, because the recording is built from
 * that slot's resolution and GOP. `rec:none` and `rec:high` are different
 * accessories; so are `rec:mid` and `rec:high`.
 *
 * ## Unreadable is not "cannot record"
 *
 * The one case that must NOT move the fingerprint. A transient read failure
 * looks exactly like a camera with no profiles, and letting it through would
 * tear down and republish a working accessory every time a read blipped —
 * which is the churn the fingerprint exists to prevent.
 */
import type { RtspEntryLike } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import {
  recordabilityToken,
  recordabilityTokenFor,
  withRecordabilityToken,
} from '../recordability-token.js'

const entry = (
  profile: 'high' | 'mid' | 'low',
  width: number,
  height: number,
  over: Record<string, unknown> = {},
): RtspEntryLike => ({
  brokerId: profile,
  profile,
  enabled: true,
  codec: 'h264',
  url: `rtsp://cam/\${profile}`,
  mutedUrl: `rtsp://cam/\${profile}?muted=1`,
  resolution: { width, height },
  ...over,
})

describe('recordabilityToken', () => {
  it('names the slot that would be recorded', () => {
    // The largest copyable at or below the ceiling — `pickRecordingSource`'s
    // rule, not a second copy of it.
    expect(recordabilityToken([entry('low', 640, 360), entry('mid', 1280, 720)])).toBe('rec:mid')
  })

  it('changes when a bigger slot appears', () => {
    const before = recordabilityToken([entry('low', 640, 360)])
    const after = recordabilityToken([entry('low', 640, 360), entry('mid', 1280, 720)])
    expect(before).not.toBe(after)
  })

  it('is `rec:none` when nothing is recordable', () => {
    expect(recordabilityToken([])).toBe('rec:none')
    expect(recordabilityToken([entry('low', 640, 360, { enabled: false })])).toBe('rec:none')
    expect(recordabilityToken([entry('low', 640, 360, { codec: 'h265' })])).toBe('rec:none')
  })

  it('moves from `rec:none` to a slot when the profiles arrive — the whole point', () => {
    expect(recordabilityToken([])).not.toBe(recordabilityToken([entry('mid', 1280, 720)]))
  })

  it('is NULL when the profiles could not be read at all', () => {
    // Null means "do not move the fingerprint" — a blipped read must not
    // republish a working accessory, and it is indistinguishable from a
    // camera with no profiles by any other signal.
    expect(recordabilityToken(null)).toBeNull()
  })

  it('is stable for the same set in a different order', () => {
    const a = recordabilityToken([entry('low', 640, 360), entry('mid', 1280, 720)])
    const b = recordabilityToken([entry('mid', 1280, 720), entry('low', 640, 360)])
    expect(a).toBe(b)
  })
})

describe('withRecordabilityToken', () => {
  it('appends a read token', () => {
    expect(
      withRecordabilityToken({ base: 'dev:107:camera', token: 'rec:high', persisted: undefined }),
    ).toBe('dev:107:camera|rec:high')
  })

  it('carries the PERSISTED token forward when the read failed', () => {
    // The blip case. Without this the fingerprint would drop the token,
    // differ from what was advertised, and republish the accessory — a
    // detach, a re-attach and a `c#` bump, visible in HomeKit, for nothing.
    expect(
      withRecordabilityToken({
        base: 'dev:107:camera',
        token: null,
        persisted: 'dev:107:camera|rec:high',
      }),
    ).toBe('dev:107:camera|rec:high')
  })

  it('leaves a pre-token persisted entry alone when the read failed', () => {
    // An accessory advertised before this field existed carries no token. A
    // failed read must not invent one for it either.
    expect(
      withRecordabilityToken({ base: 'dev:107:camera', token: null, persisted: 'dev:107:camera' }),
    ).toBe('dev:107:camera')
    expect(
      withRecordabilityToken({ base: 'dev:107:camera', token: null, persisted: undefined }),
    ).toBe('dev:107:camera')
  })

  it('carries the token forward ONLY onto the base it came from', () => {
    // The device also changed shape while the profiles were unreadable. The
    // shape change is a real rebuild; the token is not its to answer for.
    expect(
      withRecordabilityToken({
        base: 'dev:107:camera+ptz',
        token: null,
        persisted: 'dev:107:camera|rec:high',
      }),
    ).toBe('dev:107:camera+ptz')
  })

  it('a read token beats the persisted one — that IS the rebuild', () => {
    expect(
      withRecordabilityToken({
        base: 'dev:107:camera',
        token: 'rec:high',
        persisted: 'dev:107:camera|rec:none',
      }),
    ).toBe('dev:107:camera|rec:high')
  })
})

describe('recordabilityTokenFor — the transcode branch', () => {
  const hevc = entry('mid', 1280, 720, { codec: 'hevc' })

  it('names a transcoding camera as its own accessory', () => {
    // It was `rec:none` before the branch existed. A camera that now records
    // via a permanent encoder must not keep a fingerprint that says it records
    // nothing — that was exactly the defect D587 closed.
    expect(recordabilityTokenFor({ entries: [hevc] })).toBe('rec:mid+x')
  })

  it('is `rec:none` for the same camera when the operator refuses the transcode', () => {
    expect(recordabilityTokenFor({ allowTranscode: false, entries: [hevc] })).toBe('rec:none')
  })

  it('a copy and a transcode of the SAME slot are different fingerprints', () => {
    // One is 0.7 % of a core; the other is most of one, permanently. Flipping
    // the switch has to rebuild.
    expect(recordabilityTokenFor({ entries: [hevc] })).not.toBe(
      recordabilityTokenFor({ entries: [entry('mid', 1280, 720)] }),
    )
  })
})
