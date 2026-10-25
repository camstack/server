/**
 * The audio classifier's class offer carries an ICON ID, not an emoji.
 *
 * `enabledAudioClasses` built each chip label as `` `${l.icon} ${l.name}` `` —
 * the glyph was baked into the LABEL STRING, server-side, as an emoji. That is
 * a presentation decision taken in the wrong package: the renderer had no way
 * to draw the class any other way, and the admin ended up with 25 emoji chips
 * while the viewer drew the same 25 classes with the shared lucide set.
 *
 * A config option now carries `iconId` — data, resolved by whichever renderer
 * picks it up (`resolveEventKindIcon` on the web, `lucide-react-native` in the
 * viewer). The label goes back to being only the words.
 */
import { describe, it, expect } from 'vitest'
import { AUDIO_MACRO_LABELS, audioKindId } from '@camstack/types'
import type { ConfigField, ConfigMultiSelectField } from '@camstack/types'

import { getStep } from '../registry/step-definitions.js'

const AUDIO_STEP_ID = 'audio-classifier'

/** Emoji / pictograph / variation-selector code points, matched individually. */
const EMOJI_RANGES: readonly (readonly [number, number])[] = [
  [0x2600, 0x27bf],
  [0xfe0f, 0xfe0f],
  [0x1f000, 0x1faff],
]

function hasEmoji(text: string): boolean {
  for (const char of text) {
    const cp = char.codePointAt(0)
    if (cp === undefined) continue
    if (EMOJI_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return true
  }
  return false
}

function multiSelect(
  fields: readonly ConfigField[],
  key: string,
): ConfigMultiSelectField | undefined {
  return fields.find(
    (f): f is ConfigMultiSelectField => 'type' in f && f.type === 'multiselect' && f.key === key,
  )
}

describe('audio-classifier — the class offer', () => {
  const field = multiSelect(getStep(AUDIO_STEP_ID).getConfigSchema(), 'enabledAudioClasses')

  it('offers every macro class', () => {
    expect(field).toBeDefined()
    expect(field!.options.map((o) => o.value)).toEqual(AUDIO_MACRO_LABELS.map((l) => l.id))
  })

  it('labels each class with WORDS only — no emoji baked into the string', () => {
    const withEmoji = field!.options.filter((o) => hasEmoji(o.label)).map((o) => o.label)
    expect(withEmoji, `emoji still in labels: ${withEmoji.join(', ')}`).toEqual([])
    expect(field!.options.map((o) => o.label)).toEqual(AUDIO_MACRO_LABELS.map((l) => l.name))
  })

  it('carries the taxonomy icon id so a renderer can draw the shared glyph', () => {
    expect(field!.options.map((o) => o.iconId)).toEqual(
      AUDIO_MACRO_LABELS.map((l) => audioKindId(l.id)),
    )
  })
})
