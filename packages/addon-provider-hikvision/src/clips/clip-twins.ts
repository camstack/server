/**
 * Which copy of a recording a requested profile means — the ONE place that
 * decides it, exactly as D599 requires of the Reolink path.
 *
 * The answer here is short, and the reason it is short is the whole point.
 *
 * ## This camera archives ONE copy, and it is the 4K main
 *
 * `GET /ISAPI/ContentMgmt/record/tracks` on 1436 lists exactly one track:
 * `101`, `codecType=H.265, resolution=3840x2160`. There is no sub-stream
 * archive. So every ask — `low`, `mid`, `high`, or none at all — is served the
 * main copy, and `served` says `high` because that is what is on the wire.
 *
 * ## The trap this function exists to be immune to
 *
 * The feasibility note measured that `DESCRIBE` on track **102** answers 200
 * with an SDP advertising `x-dimensions:1280,720`, and then delivers
 * byte-identical output to track 101 — the 4K main stream, same packet count,
 * same bytes. A provider that probed for a twin by DESCRIBEing 102 and
 * trusting the advertised dimensions would conclude it had a sub-stream
 * archive and ship ~33x the bytes under the cheap name. **Nothing in this
 * provider ever DESCRIBEs a track to decide whether it exists.** The archive's
 * tracks come from `record/tracks`, and the catalog's rows come from
 * `search`, and both name the track they mean.
 *
 * ## Why this is an UPGRADE and why it is reported
 *
 * D599 built `served` around substituting DOWNWARDS: a `high` ask answered
 * with the sub copy, said out loud. This is the mirror image — a `low` ask
 * answered with the main copy — and the contract has room to STATE it
 * (`served` is a full `CamProfile`, not a flag) but the broker's line fires
 * only on a downgrade, so the cost would otherwise be invisible by design.
 * {@link ClipQualityChoice.upgraded} is what the provider logs, per camera,
 * so a `low` ask that cost 4K bytes is a line and not a surprise.
 */
import type { CamProfile } from '@camstack/types'

/**
 * Which archived copy a call means. One member, because the camera archives
 * one — a union of one is how the type says "there is no choice here" in a
 * way a future second copy has to come back and change.
 */
export type ClipTwin = 'main'

export interface ClipQualityChoice {
  readonly twin: ClipTwin
  /** What the caller will ACTUALLY be served — never what it asked for. */
  readonly served: CamProfile
  /**
   * The caller asked for something CHEAPER than what it is getting.
   *
   * Not an error and not refusable — there is nothing cheaper to serve — but
   * it must never pass unremarked: the operator asked for `low` and is paying
   * for 4K, and the only place that can say so is the side that knows both
   * numbers.
   */
  readonly upgraded: boolean
}

/**
 * The one mapping. An ABSENT profile is not an upgrade: a caller that stated
 * no preference stated no ask, and D382's rule is that an unstated ask is
 * zero — there is nothing for the line to be about.
 */
export function chooseClipQuality(profile: CamProfile | undefined): ClipQualityChoice {
  return {
    twin: 'main',
    served: 'high',
    upgraded: profile !== undefined && profile !== 'high',
  }
}
