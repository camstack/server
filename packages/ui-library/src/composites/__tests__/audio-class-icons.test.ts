/**
 * Every audio macro class must resolve to a REAL shared glyph.
 *
 * The sound classes were rendered as emoji in two admin surfaces (the audio
 * classifier's `enabledAudioClasses` chips, built server-side with the glyph
 * baked into the label string, and the notification-rule `AudioField`), while
 * the viewer already drew the same 25 classes with lucide icons out of
 * `EVENT_KIND_ICONS`. Two icon vocabularies for one taxonomy is the drift this
 * package exists to prevent.
 *
 * `resolveEventKindIcon` never fails — an unmapped `audio-*` id silently
 * degrades to `Volume2`. So a "does it render" test proves nothing: this asserts
 * an EXPLICIT entry exists for each macro id, which is the only way a class
 * added to `AUDIO_MACRO_LABELS` without a glyph fails here instead of shipping
 * as 25 identical speaker icons.
 */
import { describe, it, expect } from 'vitest'
import { AUDIO_MACRO_LABELS, audioKindId } from '@camstack/types'
import { EVENT_KIND_ICONS, resolveEventKindIcon } from '../event-kind-visuals'

describe('audio macro classes → shared lucide glyphs', () => {
  it('namespaces every macro id into the taxonomy `audio-` space', () => {
    expect(AUDIO_MACRO_LABELS.map((l) => audioKindId(l.id))).toEqual(
      AUDIO_MACRO_LABELS.map((l) => `audio-${l.id}`),
    )
    // Idempotent: an already-namespaced id is not double-prefixed, so a rule
    // storing the taxonomy spelling resolves to the same glyph.
    expect(audioKindId('audio-dog')).toBe('audio-dog')
  })

  it('declares an EXPLICIT glyph for every macro class (no silent fallback)', () => {
    const missing = AUDIO_MACRO_LABELS.filter(
      (l) => !Object.hasOwn(EVENT_KIND_ICONS, audioKindId(l.id)),
    ).map((l) => l.id)
    expect(missing, `audio classes with no glyph: ${missing.join(', ')}`).toEqual([])
  })

  it('resolves each class to a component', () => {
    for (const l of AUDIO_MACRO_LABELS) {
      expect(resolveEventKindIcon(audioKindId(l.id))).toBeTypeOf('object')
    }
  })
})
