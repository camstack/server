/**
 * The D276 vocabulary, in ONE place for every admin surface that draws a
 * track's best shot.
 *
 * The operator's report was *"tante detections con best shot la targa, ma manca
 * l'auto! E ancora facce senza la persona"*
 * [The operator's words: "many detections with the plate as best shot, but
 * the car is missing! And still faces without the person".]
 * ([D276](../../../../../docs/decisions/adr-0276-a-stand-in-tile-is-provisional-and-a-close-says-why.md)).
 * The pipeline's answer has two halves, and a surface that shows one without
 * the other is worse than showing neither:
 *
 *  - **provenance** — WHERE the shown tile's bytes came from. `native` (a live
 *    capture or a keyFrame derive) > `raster` (an honest sub-native subject
 *    crop) > `standin` (a face/plate DETAIL crop standing in for the subject).
 *    A stand-in is legitimate — the operator accepted it — but it must be
 *    *visibly* a stand-in, never rendered as if it were a best shot.
 *  - **`previewMissReason`** — WHY the close produced no native tile, as a
 *    composed token line (`no-key-frame capture=keyframe:native-missx4`).
 *
 * Two rules this module exists to hold:
 *
 *  1. **`native` and "unrecorded" both render NOTHING.** A row written before
 *     the provenance column ranks `native` by the D276 rule precisely because
 *     it cannot be classified — so badging it would turn "we cannot tell" into
 *     an accusation, on the entire pre-column history at once.
 *  2. **The raw token line is never thrown away.** The sentences below are this
 *     surface's; the tokens are the pipeline's, and they are what an operator
 *     greps the hub log for. The sentence is shown, the line is kept beside it.
 */

import i18n from '../../i18n/index'

export const MEDIA_PROVENANCES = ['native', 'raster', 'standin'] as const
export type MediaProvenance = (typeof MEDIA_PROVENANCES)[number]

export function isMediaProvenance(value: unknown): value is MediaProvenance {
  return MEDIA_PROVENANCES.some((p) => p === value)
}

/** How a below-native tile is badged. `native` has no entry — see rule 1. */
export interface ProvenanceBadge {
  /** The word on the badge. Short — it sits over a thumbnail. */
  readonly label: string
  /** The whole sentence, as the badge's `title`. */
  readonly title: string
  /** `warning` for a stand-in, `info` for a raster crop. */
  readonly tone: 'warning' | 'info'
}

function provenanceBadgeFor(kind: 'raster' | 'standin'): ProvenanceBadge {
  return kind === 'standin'
    ? {
        label: i18n.t('helpers.mediaProvenance.standin.label'),
        title: i18n.t('helpers.mediaProvenance.standin.title'),
        tone: 'warning',
      }
    : {
        label: i18n.t('helpers.mediaProvenance.raster.label'),
        title: i18n.t('helpers.mediaProvenance.raster.title'),
        tone: 'info',
      }
}

/**
 * The badge for a tile's provenance, or `null` when there is nothing to say.
 *
 * `null` covers BOTH `native` and "no provenance was reported" — see rule 1.
 * Callers render nothing on `null`; they must never substitute a "native"
 * badge, which would claim a fact about every legacy row that nobody checked.
 */
export function provenanceBadge(provenance: MediaProvenance | undefined): ProvenanceBadge | null {
  if (provenance === 'standin') return provenanceBadgeFor('standin')
  if (provenance === 'raster') return provenanceBadgeFor('raster')
  return null
}

/** One token of a `previewMissReason` line, split from its value. */
export interface PreviewMissToken {
  readonly key: string
  readonly value: string | null
}

/**
 * The leading token's human sentence. An UNKNOWN token falls back to the token
 * itself rather than being hidden: the addon deploys separately from this
 * bundle and can ship a reason this build has never heard of — and a new defect
 * silently not rendering is the worst way to learn that.
 */
const MISS_SENTENCE_KEYS: Readonly<Record<string, string>> = {
  'no-key-frame': 'helpers.mediaProvenance.miss.noKeyFrame',
  'no-best-seen-bbox': 'helpers.mediaProvenance.miss.noBestSeenBbox',
  'derive-returned-null': 'helpers.mediaProvenance.miss.deriveReturnedNull',
  'derive-threw': 'helpers.mediaProvenance.miss.deriveThrew',
  'derive-not-wired': 'helpers.mediaProvenance.miss.deriveNotWired',
  'no-media-store': 'helpers.mediaProvenance.miss.noMediaStore',
  'no-thumbnail': 'helpers.mediaProvenance.miss.noThumbnail',
  'standin-tile': 'helpers.mediaProvenance.miss.standinTile',
  'raster-tile': 'helpers.mediaProvenance.miss.rasterTile',
  'native-tile': 'helpers.mediaProvenance.miss.nativeTile',
}

export interface PreviewMissDescription {
  /** One sentence for the leading token — what the close could not produce. */
  readonly sentence: string
  /** The `key=value` tokens that followed it, in order, unparsed values. */
  readonly detail: readonly PreviewMissToken[]
  /** The line exactly as the pipeline wrote it. Always kept — it is greppable. */
  readonly raw: string
}

/**
 * Split a composed `previewMissReason` into a sentence plus its tokens.
 *
 * Returns `null` for an absent or blank line, which is the SAME answer as "the
 * tile landed native" — absent means "nothing to say", never "it went fine",
 * and a caller renders nothing either way.
 */
export function describePreviewMiss(reason: string | undefined): PreviewMissDescription | null {
  if (reason === undefined) return null
  const raw = reason.trim()
  if (raw.length === 0) return null
  const parts = raw.split(/\s+/)
  const head = parts[0] ?? raw
  const detail: PreviewMissToken[] = []
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=')
    if (eq === -1) detail.push({ key: part, value: null })
    else detail.push({ key: part.slice(0, eq), value: part.slice(eq + 1) })
  }
  const sentenceKey = MISS_SENTENCE_KEYS[head]
  return { sentence: sentenceKey === undefined ? head : i18n.t(sentenceKey), detail, raw }
}
