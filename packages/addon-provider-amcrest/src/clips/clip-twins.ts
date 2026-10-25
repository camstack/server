/**
 * Which copy of a recording a requested profile means — the ONE place that
 * decides it, exactly as D599 requires.
 *
 * ## This camera archives ONE copy, and it is the main
 *
 * Measured, not inferred (device 3836, 2026-09-23):
 *
 * - `Record[0].Stream = 0` — the camera writes the main format only.
 * - `loadfile.cgi?…&subtype=1`, over a window that definitely holds footage,
 *   answers **400**, where the same window at `subtype=0` answers 200 with
 *   54 MB. **There is no sub twin in the archive.**
 * - Every catalog row carries `VideoStream: "Main"`. 60 of 60.
 *
 * The live sub-stream (640x480, 512 kbps) exists, but only live. So every ask
 * — `low`, `mid`, `high`, or none — is served the main copy, and `served` says
 * `high`, because that is what is on the wire.
 *
 * ## Why this is an UPGRADE, and why it is reported QUIETLY
 *
 * D599 built `served` around substituting DOWNWARDS: a `high` ask answered
 * with the sub copy, said out loud, because a silent 33× cheaper substitution
 * is a lie. Here it is the mirror image — a `low` ask answered with a copy
 * carrying **12.5× the bitrate** (6.39 Mbit/s against the sub-stream's 512
 * kbps) and 12× the pixels — and the broker's honesty line fires only on a
 * downgrade, so nothing else will say it.
 *
 * It is reported ONCE per camera per asked profile rather than per clip. The
 * discriminator D599 really wants is not the DIRECTION of the substitution but
 * whether the provider had a CHOICE, and on a one-copy source it never does:
 * a line on every ordinary clip would be noise at exactly the rate the clips
 * arrive. {@link ClipUpgradeNotes} is that bookkeeping, and it carries the
 * count it suppressed so the quiet is never mistaken for absence (D391).
 *
 * ## Why the standing fact is NOT declared on `ClipPlaybackOptions`
 *
 * It was proposed (the 2026-09-23 re-measurement, contract question 1): a
 * per-provider "one copy only" field beside `rates`, so a viewer stops
 * offering a picker it cannot honour. It is not taken, and the reason is in
 * the consumer rather than in the schema.
 *
 * The viewer's quality picker is already driven by the ROW — `Clip.streams`,
 * resolved at listing time — and `clip-export-quality.ts` says in as many
 * words that it deliberately does not read `getPlaybackOptions`, because that
 * envelope describes how a clip is DRIVEN and the copies that exist are a
 * property of the recording. Adding the fact there would put a second
 * authority next to the one the viewer just finished consolidating onto, and
 * the viewer would go on ignoring it.
 *
 * The shipped contract already has the expression: a `streams` block holding
 * only `main`, and `supportSub: false`. Both are per clip, both are already
 * read, and this provider sets both. The gap the re-measurement found is real,
 * but it is a missing READER of the ladder in the upgrade direction, not a
 * missing field — which is candidate 1 of the three it listed.
 */
import type { CamProfile } from '@camstack/types'

/**
 * Which archived copy a call means. One member, because the camera archives
 * one — a union of one is how the type says "there is no choice here" in a way
 * a future second copy has to come back and change.
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
   * for 2560x1440 at 6.4 Mbit/s, and the only side that knows both numbers is
   * this one.
   */
  readonly upgraded: boolean
}

/**
 * The one mapping. An ABSENT profile is not an upgrade: a caller that stated
 * no preference stated no ask, and D382's rule is that an unstated ask is
 * zero — there is nothing for a line to be about.
 */
export function chooseClipQuality(profile: CamProfile | undefined): ClipQualityChoice {
  return {
    twin: 'main',
    served: 'high',
    upgraded: profile !== undefined && profile !== 'high',
  }
}

/** What an upgrade line should say, or that it should not be said again. */
export type ClipUpgradeNote =
  | { readonly kind: 'silent' }
  | { readonly kind: 'say'; readonly asked: CamProfile; readonly suppressedSince: number }

/**
 * One-per-(camera, asked profile) bookkeeping for the upgrade line.
 *
 * Deliberately a plain object rather than a module-level map: a second runner
 * of this addon must not inherit another's "already said that".
 */
export class ClipUpgradeNotes {
  private readonly said = new Map<string, number>()

  /** Note one upgraded ask and say whether it is worth a line. */
  note(deviceId: number, asked: CamProfile): ClipUpgradeNote {
    const key = `${String(deviceId)}|${asked}`
    const seen = this.said.get(key)
    if (seen === undefined) {
      this.said.set(key, 0)
      return { kind: 'say', asked, suppressedSince: 0 }
    }
    this.said.set(key, seen + 1)
    return { kind: 'silent' }
  }

  /** How many asks this camera/profile pair has made since its one line. Read
   *  by the listing log, so the quiet carries its own denominator. */
  suppressed(deviceId: number, asked: CamProfile): number {
    return this.said.get(`${String(deviceId)}|${asked}`) ?? 0
  }
}
