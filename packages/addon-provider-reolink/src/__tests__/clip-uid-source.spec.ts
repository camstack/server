/**
 * WHICH copy of the uid a clip read is allowed to believe.
 *
 * ## The live defect this exists for
 *
 * 3825 (stanza caldaia, a hub child) answered `videoclips.listClips` with
 * `unreachable: uid-missing` while HOLDING a uid — `9527000MSU931AUT`, in
 * `deviceMeta.metadata.uid`, read off the running hub on 2026-09-21. Its two
 * siblings 3628 and 3629 listed normally.
 *
 * The uid lives in two places. `metadata.uid` is written when the device is
 * adopted and refreshed from the firmware afterwards; `config.uid` is a COPY
 * taken at adoption (`reolink-hub.ts`: `...(entry.metadata.uid ? { uid } : {})`)
 * and never written again. A camera adopted before that line existed, or whose
 * discovery payload carried no uid at the time, keeps an empty `config.uid` for
 * ever — and `getClipDeviceRef` consulted only that one.
 *
 * So this is [D224] wearing a vendor hat: a device fact kept fresh by the
 * addon that owns the device, and a consumer holding a second copy that is
 * stale by construction. `clip-addressing.ts`'s own docblock already named the
 * right authority ("as `deviceMeta.metadata.uid` holds it"); it was the reader
 * that consulted the other one.
 *
 * ## Why a brand rather than a rule
 *
 * A paragraph saying "read the metadata" is a rule nothing checks, and this
 * repo has shipped that failure. {@link CameraUid} can only be minted by
 * {@link resolveCameraUid}, which is handed BOTH sources — so a future reader
 * that reaches for one copy does not produce a subtly wrong answer, it fails
 * to compile.
 */
import { describe, expect, it } from 'vitest'

import { resolveCameraUid } from '../clips/clip-addressing.js'

const META = '9527000MSU931AUT'
const STALE = '9527000HXOHJ142G'

describe('resolveCameraUid', () => {
  it('prefers the METADATA, which is the copy that is kept fresh', () => {
    expect(resolveCameraUid({ metadataUid: META, configUid: undefined })).toBe(META)
  })

  it('answers the metadata even when the config disagrees', () => {
    // Not hypothetical: the config copy is frozen at adoption, so a camera
    // re-adopted under a new uid would keep the old one there for ever.
    expect(resolveCameraUid({ metadataUid: META, configUid: STALE })).toBe(META)
  })

  it('falls back to the config before the metadata has been read', () => {
    // The metadata read happens once per addon start. Until it lands the
    // adoption copy is all there is, and it is right for most cameras — the
    // fallback is what keeps this change from regressing 3628 and 3629.
    expect(resolveCameraUid({ metadataUid: undefined, configUid: STALE })).toBe(STALE)
  })

  it('is undefined when neither holds one — a standalone, and that is fine', () => {
    // 592 has no persisted uid and never will; nothing writes one for a
    // standalone, and the camera ignores it anyway.
    expect(resolveCameraUid({ metadataUid: undefined, configUid: undefined })).toBeUndefined()
  })

  it.each([
    ['empty metadata', { metadataUid: '', configUid: STALE }, STALE],
    ['empty config', { metadataUid: undefined, configUid: '' }, undefined],
    ['both empty', { metadataUid: '', configUid: '' }, undefined],
  ])('treats %s as ABSENT, never as a uid', (_label, sources, expected) => {
    // An empty string is how a cleared settings field arrives. Passed on, it
    // addresses no camera at all and the refusal would name the wrong cause.
    expect(resolveCameraUid(sources)).toBe(expected)
  })

  it('trims, because a uid pasted into a settings field carries whitespace', () => {
    expect(resolveCameraUid({ metadataUid: `  ${META} `, configUid: undefined })).toBe(META)
  })
})
