import type { SiteZone } from '@camstack/types'
import { Label, Select, type SelectOption } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

/**
 * Which ZONE this room belongs to.
 *
 * Edited here, on the room, and nowhere else. A screen that also assigned rooms
 * from the zone's side would be two places to change one fact — the shape that
 * let a location's description drift away from its icon until a rename dropped
 * one and kept the other.
 *
 * A room belongs to at most one zone, so this is a select and not a set of
 * checkboxes: the constraint is in the control, not in a validation message
 * after the fact.
 */
export interface LocationZoneFieldProps {
  readonly name: string
  readonly zones: readonly SiteZone[]
  /** The zone key this room is in, or `null` when it is in none. */
  readonly zoneKey: string | null
  readonly busy: boolean
  readonly onChange: (zone: string | null) => void | Promise<void>
}

/** The empty option's value. Not the empty string, which a zone label could
 *  fold to — and a zone that silently means "no zone" is worse than no
 *  control. */
const NONE = ' none'

export function LocationZoneField({
  name,
  zones,
  zoneKey,
  busy,
  onChange,
}: LocationZoneFieldProps) {
  const { t } = useTranslation()
  if (zones.length === 0) return null
  const options: SelectOption[] = [
    { value: NONE, label: t('locations.locationZoneField.none', '— none —') },
    ...zones.map((zone) => ({ value: zone.zoneKey, label: zone.label })),
  ]
  return (
    <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 sm:px-4 sm:py-2">
      <Label htmlFor={`location-zone-${name}`}>
        {t('locations.locationZoneField.zone', 'Zone')}
      </Label>
      <Select
        id={`location-zone-${name}`}
        value={zoneKey ?? NONE}
        disabled={busy}
        onChange={(e) => {
          const next = e.target.value
          if (next === NONE) {
            void onChange(null)
            return
          }
          // The LABEL goes to the server, not the key: the key is the fold of
          // the label and the server folds it again, so sending the label keeps
          // one derivation instead of two spellings of the same rule.
          const zone = zones.find((z) => z.zoneKey === next)
          if (zone !== undefined) void onChange(zone.label)
        }}
        options={options}
      />
    </div>
  )
}

/** The zone key a location belongs to, or `null`. */
export function zoneKeyOfLocation(zones: readonly SiteZone[], locationKey: string): string | null {
  return zones.find((z) => z.locationKeys.includes(locationKey))?.zoneKey ?? null
}
