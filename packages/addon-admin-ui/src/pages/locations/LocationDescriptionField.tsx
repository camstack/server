import { useEffect, useState } from 'react'

import { LOCATION_DESCRIPTION_MAX } from '@camstack/types'
import { Label, TEXT_HINT } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

/**
 * What a room LOOKS like, in the operator's own words.
 *
 * It sits on the location and not in a notification setting because it is a
 * fact about the PLACE: the same sentence serves every camera there, and it
 * has to survive a rename exactly as the icon does. It lived in the
 * post-analysis addon's settings, as a free-text location name retyped by hand
 * and matched case-sensitively, and a rename here silently orphaned it.
 *
 * Saved on BLUR, not per keystroke: every save is a write to the shared addon
 * store under a lock, and a description is a sentence someone types slowly.
 * The draft is local until then, and an unchanged draft writes nothing.
 */
export interface LocationDescriptionFieldProps {
  readonly name: string
  /** The stored text, or `null` when nobody has written one. */
  readonly description: string | null
  readonly busy: boolean
  readonly onSave: (description: string | null) => void | Promise<void>
}

export function LocationDescriptionField({
  name,
  description,
  busy,
  onSave,
}: LocationDescriptionFieldProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(description ?? '')
  // Follow the server when it changes UNDER us — a rename rewrites the key, and
  // the card would otherwise keep showing the text of the room it used to be.
  useEffect(() => {
    setDraft(description ?? '')
  }, [description])

  const commit = (): void => {
    const next = draft.trim()
    if (next === (description ?? '')) return
    // Blank clears. An empty description and no description are the same thing
    // to the model that reads it, so they must not be two states here either.
    void onSave(next.length === 0 ? null : next)
  }

  return (
    <div className="border-t border-border px-3 py-2 sm:px-4">
      <Label htmlFor={`location-description-${name}`} className="block">
        {t('locations.locationDescriptionField.whatIsThere', 'What is there')}
      </Label>
      <textarea
        id={`location-description-${name}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        disabled={busy}
        rows={2}
        maxLength={LOCATION_DESCRIPTION_MAX}
        placeholder={t(
          'locations.locationDescriptionField.surfacesBoundariesWhatIsNormally',
          'Surfaces, boundaries, what is normally parked or stored here.',
        )}
        className="mt-1 w-full resize-y rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
      />
      <p className={`mt-1 ${TEXT_HINT}`}>
        {t(
          'locations.locationDescriptionField.givenToTheAiWith',
          'Given to the AI with the pictures, so it knows what it is looking at. Describe the PLACE, not what happens in it — events change, the ground does not.',
        )}
      </p>
    </div>
  )
}

/**
 * The description stored for a location key, or `null` when there is none.
 *
 * `null` and `''` must not both reach the card: one is "nobody wrote one" and
 * the other would be a written blank, which the store refuses to keep anyway.
 */
export function pickLocationDescription(
  assignments: ReadonlyArray<{ locationKey: string; description: string }> | undefined,
  locationKey: string,
): string | null {
  const found = assignments?.find((a) => a.locationKey === locationKey)
  return found === undefined || found.description.length === 0 ? null : found.description
}
