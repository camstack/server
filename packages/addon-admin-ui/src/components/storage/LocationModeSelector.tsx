/**
 * The four-way state selector on a location row — one control where two
 * switches (Enabled/Disabled and Writable/Read-only) used to disagree.
 *
 * Every choice states its consequence ON the choice, not in a tooltip: the
 * operator picking `Disabled` reads, before clicking, that the footage stored
 * there leaves the timeline. A choice the server would refuse is still
 * rendered, greyed, with the reason — so "why can't I?" is answered where the
 * question is asked.
 *
 * ## Why the choices are not a floating panel
 *
 * They were: a `w-80` popover anchored to the trigger, which sits at the RIGHT
 * end of a row. On a phone that panel was wider than the viewport, so it was
 * clipped off the left edge — three unreadable fragments of consequence text
 * hanging over the cards below, covering the page, on a device with no hover to
 * dismiss them with. The choices are now an ordinary block the CARD lays out
 * full-width beneath the row: it cannot overflow a viewport it is inside of, it
 * pushes the rows below down instead of covering them, and it is dismissed by
 * the trigger, the Close button, or Escape.
 */
import { Archive, ChevronDown, EyeOff, HardDriveDownload, Power, X } from 'lucide-react'
import { useEffect } from 'react'
import {
  LOCATION_MODE_CHOICES,
  type LocationMode,
  type LocationModeReasons,
  locationModeChoice,
} from './location-mode'
import { useTranslation } from 'react-i18next'

const MODE_ICON: Readonly<Record<LocationMode, typeof Power>> = {
  active: Power,
  readonly: Archive,
  drain: HardDriveDownload,
  disabled: EyeOff,
}

const MODE_TRIGGER_CLASS: Readonly<Record<LocationMode, string>> = {
  active: 'border-success/30 text-success hover:bg-success/10',
  readonly: 'border-border text-foreground-subtle hover:text-foreground hover:bg-primary/10',
  drain: 'border-warning/40 text-warning hover:bg-warning/10',
  disabled: 'border-danger/40 text-danger hover:bg-danger/10',
}

export interface LocationModeTriggerProps {
  readonly mode: LocationMode
  readonly open: boolean
  readonly onToggle: () => void
}

/** The button in the row's action strip. Opening is the card's business. */
export function LocationModeTrigger({ mode, open, onToggle }: LocationModeTriggerProps) {
  const { t } = useTranslation()
  const current = locationModeChoice(mode)
  const Icon = MODE_ICON[mode]
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={t('storage.locationModeSelector.locationState', 'Location state')}
      onClick={onToggle}
      title={current.consequence}
      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium border ${MODE_TRIGGER_CLASS[mode]}`}
    >
      <Icon className="h-3 w-3" />
      {current.label}
      <ChevronDown className={`h-3 w-3 ${open ? 'rotate-180' : ''}`} />
    </button>
  )
}

export interface LocationModeChoicesProps {
  readonly mode: LocationMode
  /** Per-mode refusal reason; the empty string means the choice is allowed. */
  readonly blockedReasons: LocationModeReasons
  readonly onSelect: (next: LocationMode) => void
  readonly onDismiss: () => void
}

export function LocationModeChoices({
  mode,
  blockedReasons,
  onSelect,
  onDismiss,
}: LocationModeChoicesProps) {
  const { t } = useTranslation()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onDismiss])
  return (
    <div
      // In flow, full width, inside the card: nothing to clip and nothing to
      // cover. `basis-full` makes it wrap onto its own line of the card's row.
      className="w-full basis-full rounded-lg border border-border bg-background p-1"
      role="group"
      aria-label={t('storage.locationModeSelector.locationStateChoices', 'Location state choices')}
    >
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[10px] uppercase tracking-wide text-foreground-subtle">
          {t('storage.locationModeSelector.locationState', 'Location state')}
        </span>
        <button
          type="button"
          aria-label={t(
            'storage.locationModeSelector.closeLocationStateChoices',
            'Close location state choices',
          )}
          onClick={onDismiss}
          className="text-foreground-subtle hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {LOCATION_MODE_CHOICES.map((choice) => {
        const reason = blockedReasons[choice.mode]
        const blocked = reason !== ''
        const Icon = MODE_ICON[choice.mode]
        const selected = choice.mode === mode
        return (
          <button
            key={choice.mode}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={choice.label}
            disabled={blocked}
            onClick={() => {
              if (blocked) return
              onDismiss()
              if (!selected) onSelect(choice.mode)
            }}
            className={`flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left ${
              blocked
                ? 'cursor-not-allowed opacity-60'
                : selected
                  ? 'bg-primary/10'
                  : 'hover:bg-primary/5'
            }`}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
              <Icon className="h-3 w-3" />
              {choice.label}
              {selected && (
                <span className="text-[9px] uppercase text-primary">{t('common.current')}</span>
              )}
            </span>
            <span className="text-[10px] leading-snug text-foreground-subtle">
              {choice.consequence}
            </span>
            {blocked && <span className="text-[10px] leading-snug text-warning">{reason}</span>}
          </button>
        )
      })}
    </div>
  )
}
