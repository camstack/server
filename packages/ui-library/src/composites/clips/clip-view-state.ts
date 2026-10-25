/**
 * The clips browser's on-screen state, decided once, in one place.
 *
 * Four states have to be TELLABLE APART on screen, and that is the whole point
 * of the external-videoclips line (D549 § 7b):
 *
 *  - `loading` — never rendered as empty. A list drawn while a query is still
 *    pending is a claim the data does not support.
 *  - `empty` — a band with no rows, carrying the BAND and the sources that
 *    answered for it. "No clips" with neither of those is the lie this whole
 *    surface exists to stop telling.
 *  - `refused` — the selected band is wider than the bound `clip-band.ts`
 *    sets, so nothing was asked. Added with the timebar (D564): a band can be
 *    made arbitrarily wide and a day could not, and a range that answered
 *    partly would read as the whole of it.
 *  - `listed` — rows, plus every source that could NOT contribute, named with
 *    its reason verbatim. One unreachable source never empties the others
 *    (the dispatcher's rule 2), and the operator must see both halves: today
 *    a hub child lists `onboard` and shows `native:reolink:hub` unreachable.
 *  - `failed` — the read itself failed. Not an answer, so not "empty" either.
 *
 * There is no client-side source filter here, and that is a decision, not an
 * omission. `listClips` is asked of ONE provider at a time, and NAMING it is
 * required (`provider`, D554 amended) — the operator settled it on 2026-09-20,
 * *"l'utilizzatore è uno solo"* [there is only one user] — so what arrives is already the answer for
 * the provider on screen and there is nothing to filter out of it. What
 * survives unchanged is the rule the old filter existed to protect: every
 * source a camera HAS is still described here, with its availability,
 * whichever provider was asked.
 */
import type { Clip, ClipSource } from '@camstack/types'
import type { ClipBand, ClipBandPlan } from './clip-band.js'
import { defaultUiText, type UiTextFn } from '../../contexts/ui-text.js'
import { describeSource, type ClipSourceNotice } from './clip-source-state.js'

/** React Query's settled-ness, narrowed to what this decision needs. */
export type ClipQueryStatus = 'pending' | 'error' | 'success'

export interface ClipsViewInput {
  /**
   * The period the list is about, and whether it may be asked for at all
   * (`clip-band.ts`). A refused plan means NO query was fired, which is why
   * the refusal has to be decided here rather than inferred from a query that
   * will stay `pending` for ever.
   */
  readonly plan: ClipBandPlan
  /**
   * The provider the clip list was asked of, or `null` when the camera lists
   * NO source to ask.
   *
   * Naming one is required (D554 amended), so "nobody to ask" is a real state and it
   * has to be told apart from "not answered yet": the query never fires, its
   * status stays `pending` for ever, and a surface that only consults the
   * status spins against a question with no addressee. Exactly the trap
   * `too-wide` has, arriving from the other end.
   */
  readonly provider: string | null
  readonly clipsStatus: ClipQueryStatus
  readonly clips: readonly Clip[]
  readonly sourcesStatus: ClipQueryStatus
  readonly sources: readonly ClipSource[]
  readonly clipsError?: string
  readonly sourcesError?: string
}

export type ClipsViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      /** The band is wider than the bound, so nothing was asked. */
      readonly kind: 'refused'
      readonly band: ClipBand
      readonly localDays: number
      readonly maxLocalDays: number
    }
  | {
      readonly kind: 'empty'
      readonly band: ClipBand
      readonly answered: readonly ClipSourceNotice[]
      readonly silent: readonly ClipSourceNotice[]
      /** No source could answer at all — a different fact from a quiet day. */
      readonly nobodyAnswered: boolean
    }
  | {
      readonly kind: 'listed'
      readonly clips: readonly Clip[]
      readonly answered: readonly ClipSourceNotice[]
      readonly silent: readonly ClipSourceNotice[]
    }

export function resolveClipsView(
  input: ClipsViewInput,
  t: UiTextFn = defaultUiText,
): ClipsViewState {
  // FIRST, before any query status is consulted. A refused band fired no
  // request, so its clips query is `pending` for ever (a skeleton that never
  // resolves) and any rows still in hand belong to the NARROWER band the
  // operator had a moment ago — drawing those under the wider one is the
  // partial answer shown as if it were the range.
  if (input.plan.kind === 'too-wide') {
    return {
      kind: 'refused',
      band: input.plan.band,
      localDays: input.plan.localDays,
      maxLocalDays: input.plan.maxLocalDays,
    }
  }
  // A read that FAILED is not an answer, and an answer is what "empty" claims.
  if (input.clipsStatus === 'error') {
    return {
      kind: 'failed',
      message:
        input.clipsError ?? t('uiLibrary.clipView.clipsFailed', 'The clip list could not be read'),
    }
  }
  if (input.sourcesStatus === 'error' && input.clips.length === 0) {
    return {
      kind: 'failed',
      message:
        input.sourcesError ??
        t('uiLibrary.clipView.sourcesFailed', 'The source list could not be read'),
    }
  }
  const notices = input.sources.map((source) => describeSource(source, t))
  const answered = notices.filter((notice) => notice.answered)
  const silent = notices.filter((notice) => !notice.answered)
  const clips = input.clips

  // Nobody to ask, and the source list SAID so. The clips query never fired,
  // so its `pending` means "never asked", not "not back yet".
  if (input.provider === null && input.sourcesStatus === 'success') {
    return { kind: 'empty', band: input.plan.band, answered, silent, nobodyAnswered: true }
  }
  // Either query still out: loading. The source list is not decoration — an
  // empty day with no source list has no cause to offer, so it is not yet an
  // empty day.
  if (input.clipsStatus === 'pending' || input.sourcesStatus === 'pending') {
    return { kind: 'loading' }
  }

  if (clips.length === 0) {
    return {
      kind: 'empty',
      band: input.plan.band,
      answered,
      silent,
      nobodyAnswered: answered.length === 0,
    }
  }
  return { kind: 'listed', clips, answered, silent }
}
