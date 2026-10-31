import { Trash2, X, Hexagon, Minus } from 'lucide-react'
import { useT } from '../../i18n/index.js'
import type { Zone, ZoneKind } from './types'
import { Button } from '@camstack/ui-library'

// ---------------------------------------------------------------------------
// Kind badge helper
// ---------------------------------------------------------------------------

const KIND_COLORS: Record<ZoneKind, string> = {
  polygon: 'bg-info/10 text-info',
  tripwire: 'bg-warning/10 text-warning',
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ZoneListProps {
  zones: Zone[]
  selectedZoneId: string | null
  drawingKind: ZoneKind | null
  /** Selection IS edit-mode — `onSelectZone(id)` enters draft mode
   *  for that zone, `onSelectZone(null)` discards. */
  onSelectZone: (id: string | null) => void
  onDeleteZone: (id: string) => void
  onStartDraw: (kind: ZoneKind) => void
  onCancelDraw: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ZoneList({
  zones,
  selectedZoneId,
  drawingKind,
  onSelectZone,
  onDeleteZone,
  onStartDraw,
  onCancelDraw,
}: ZoneListProps) {
  const { t } = useT()
  return (
    <div className="flex flex-col gap-2">
      {/* Add buttons — one icon per shape kind, no text. Hexagon ⇒
          polygon area, horizontal bar ⇒ tripwire/line. While drawing,
          the same row collapses into a single Cancel button. */}
      <div className="flex items-center gap-1">
        {drawingKind ? (
          <Button
            variant="unstyled"
            type="button"
            onClick={onCancelDraw}
            className="inline-flex items-center justify-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors h-8 px-3 text-[11px] font-medium"
            title={t('zoneList.cancelDrawing')}
          >
            <X className="h-3.5 w-3.5" />
            <span>{t('zoneList.cancel')}</span>
          </Button>
        ) : (
          <>
            <Button
              variant="unstyled"
              type="button"
              onClick={() => onStartDraw('polygon')}
              className="inline-flex items-center justify-center rounded border border-border bg-surface text-foreground-subtle hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-colors h-8 w-8"
              title={t('zoneList.addPolygon')}
              aria-label={t('zoneList.addPolygon')}
            >
              <Hexagon className="h-4 w-4" />
            </Button>
            <Button
              variant="unstyled"
              type="button"
              onClick={() => onStartDraw('tripwire')}
              className="inline-flex items-center justify-center rounded border border-border bg-surface text-foreground-subtle hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-colors h-8 w-8"
              title={t('zoneList.addTripwire')}
              aria-label={t('zoneList.addTripwire')}
            >
              <Minus className="h-5 w-5 stroke-[2.5]" />
            </Button>
          </>
        )}
      </div>

      {/* Zone list */}
      {zones.length === 0 ? (
        <p className="text-center text-[10px] text-foreground-subtle py-3 leading-tight">
          {t('zoneList.empty')}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {zones.map((zone) => {
            const isSelected = zone.id === selectedZoneId
            return (
              <div
                key={zone.id}
                className={[
                  'flex items-center gap-1.5 rounded border px-1.5 py-1 cursor-pointer transition-colors',
                  isSelected
                    ? 'border-primary/50 bg-primary/10'
                    : 'border-border bg-surface hover:bg-surface-hover',
                ].join(' ')}
                onClick={() => onSelectZone(isSelected ? null : zone.id)}
              >
                {/* Color swatch */}
                <div
                  className="h-2.5 w-2.5 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: zone.color }}
                />

                {/* Name */}
                <span className="flex-1 truncate text-[11px] font-medium text-foreground">
                  {zone.name}
                </span>

                {/* Kind badge */}
                <span
                  className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium flex-shrink-0 ${KIND_COLORS[zone.kind]}`}
                >
                  {zone.kind === 'tripwire' ? t('zone.kind.tripwire') : t('zone.kind.polygon')}
                </span>

                {/* Delete — only destructive action that needs its own
                    button (selection itself enters edit mode). */}
                <Button
                  variant="unstyled"
                  type="button"
                  title={t('zoneList.deleteZone')}
                  className="p-0.5 text-foreground-subtle hover:text-danger rounded transition-colors flex-shrink-0"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteZone(zone.id)
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
