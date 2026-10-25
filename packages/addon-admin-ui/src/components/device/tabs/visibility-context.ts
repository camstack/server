/**
 * Values the Config form may READ, but not edit, to decide what to show.
 *
 * A device's settings arrive as one aggregate that the page splits into tabs.
 * A field's `showWhen` can name a key that belongs to ANOTHER tab: the frame-diff
 * analyzer's tuning (Config -> Motion) is gated on `motionSources`, which lives
 * in Detection pipeline. A form only knows the values of its own sections, and an
 * absent key reads as "not selected" -- so those knobs were hidden on every
 * camera, including the ones whose analyzer is the motion source.
 *
 * This walks the WHOLE aggregate (not the tab's slice) and returns each leaf
 * field's effective value (stored value, else its schema default). The result
 * is passed to the form as `visibilityContext`: it feeds `showWhen` only and
 * never reaches the save controller, so a context key cannot become an edit.
 */
import type { ConfigFieldWithValue, ConfigSectionWithValues } from '../../../types/config-ui'

function collect(fields: readonly ConfigFieldWithValue[], out: Record<string, unknown>): void {
  for (const field of fields) {
    if (field.type === 'group') {
      collect(field.fields, out)
      continue
    }
    if (field.type === 'sub-tabs') {
      for (const tab of field.tabs) collect(tab.fields, out)
      continue
    }
    if (!('value' in field)) continue
    const effective = field.value !== undefined ? field.value : field.default
    if (effective !== undefined) out[field.key] = effective
  }
}

export function buildVisibilityContext(
  sections: readonly ConfigSectionWithValues[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const section of sections) collect(section.fields, out)
  return out
}
