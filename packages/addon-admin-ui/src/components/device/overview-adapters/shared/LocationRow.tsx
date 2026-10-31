/**
 * Room field for Customize's identity block. Suggestions come from
 * `deviceManager.listLocations`. The row only reports edits; the page's
 * one Save persists them. Empty string clears the room.
 */
import { useMemo } from 'react'
import { MapPin } from 'lucide-react'
import { useDeviceManagerListLocations, Input } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { InfoRow } from './overview-primitives'

export function LocationRow({
  label = 'Location',
  layout = 'inline',
  bound,
}: {
  readonly deviceId: number
  readonly initialLocation: string | null
  readonly label?: string
  readonly layout?: 'inline' | 'stacked'
  readonly bound: {
    readonly value: string
    readonly onChange: (value: string) => void
  }
}) {
  const { t } = useTranslation()
  const { data } = useDeviceManagerListLocations()
  const locations: readonly string[] = (data as readonly string[] | undefined) ?? []
  const query = bound.value.trim().toLowerCase()
  const suggestions = useMemo(() => {
    if (query.length === 0) return []
    return locations.filter(
      (loc) => loc.toLowerCase() !== query && loc.toLowerCase().includes(query),
    )
  }, [locations, query])

  return (
    <InfoRow
      label={label}
      layout={layout}
      value={
        <div className="relative">
          <Input
            type="text"
            value={bound.value}
            aria-label={label}
            onChange={(e) => bound.onChange(e.target.value)}
            placeholder={t(
              'shared.locationRow.roomAreaOrLeaveEmpty',
              'Room / area (or leave empty to clear)',
            )}
            className="flex-1 min-w-0 w-full px-1.5 py-0.5 text-[11px] bg-background border border-border rounded focus:outline-none focus:border-primary"
          />
          {suggestions.length > 0 && (
            <div className="absolute z-10 left-0 right-0 mt-0.5 max-h-40 overflow-y-auto rounded-md border border-border bg-surface shadow-md">
              {suggestions.map((loc) => (
                // ui-check-ok: suggestion row, same control as the inline location editor
                <button
                  key={loc}
                  type="button"
                  onClick={() => bound.onChange(loc)}
                  className="w-full flex items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-surface-hover"
                >
                  <MapPin className="h-3 w-3 text-foreground-subtle flex-shrink-0" />
                  <span className="truncate">{loc}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      }
    />
  )
}
