import { Check, Trash2, X } from 'lucide-react'
import {
  BTN_COMPACT_DANGER,
  INPUT_COMPACT,
  useZoneEditing,
  Button,
  Input,
} from '@camstack/ui-library'
import { useT } from '../../i18n/index.js'
import type { Zone } from './types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRESET_COLORS = [
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // purple
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
]

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ZoneFormProps {
  /** Zone payload sourced from the in-flight draft. The parent only
   *  renders this form while a draft is active, so name/color/points
   *  are always the editable in-memory values. */
  zone: Zone
  onSave: () => void
  onDiscard: () => void
  onDelete: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Zone settings form. Only mounted while the operator has an active
 * draft (selection IS edit mode — see `ZonesTab.selectedZone` and the
 * `useZoneEditing` context). Save commits the draft via a single
 * `updateZone` round-trip; Discard reverts. While the form is
 * mounted, every name/color keystroke and vertex drag updates the
 * draft in-memory only — no upstream RPC fires until Save, so the
 * device-config-changed → pipeline-runner detach/attach storm is
 * batched into one cycle per save.
 */
export function ZoneForm({ zone, onSave, onDiscard, onDelete }: ZoneFormProps) {
  const { t } = useT()
  const editingCtx = useZoneEditing()
  const setName = (next: string): void => editingCtx?.updateDraft({ name: next })
  const setColor = (next: string): void => editingCtx?.updateDraft({ color: next })

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold text-foreground-subtle uppercase tracking-wider">
          {t('zoneForm.editing')}
        </h3>
        <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-medium bg-surface border border-border text-foreground-subtle">
          {zone.kind === 'tripwire' ? t('zone.kind.tripwire') : t('zone.kind.polygon')}
        </span>
      </div>

      {/* Name */}
      <Input
        type="text"
        className={INPUT_COMPACT}
        value={zone.name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSave()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onDiscard()
          }
        }}
        placeholder={t('zoneForm.namePlaceholder')}
      />

      {/* Color presets */}
      <div className="flex flex-wrap gap-1">
        {PRESET_COLORS.map((color) => (
          <Button
            variant="unstyled"
            key={color}
            type="button"
            title={color}
            className={[
              'h-4 w-4 rounded border-2 cursor-pointer transition-transform hover:scale-110',
              zone.color === color ? 'border-white scale-110' : 'border-transparent',
            ].join(' ')}
            style={{ backgroundColor: color }}
            onClick={() => setColor(color)}
          />
        ))}
      </div>

      {/* Custom color input */}
      <div className="flex items-center gap-1.5">
        <Input
          type="color"
          className="h-6 w-6 rounded border border-border bg-background cursor-pointer p-0.5"
          value={zone.color}
          onChange={(e) => setColor(e.target.value)}
        />
        <Input
          type="text"
          className={`${INPUT_COMPACT} font-mono`}
          value={zone.color}
          placeholder="#000000"
          onChange={(e) => setColor(e.target.value)}
        />
      </div>

      {/* Point count info */}
      <p className="text-[9px] text-foreground-subtle leading-tight">
        {zone.kind === 'tripwire'
          ? t('zoneForm.twoPoints')
          : t('zoneForm.pointCount', { count: zone.points.length })}
        {zone.points.length > 0 && ` ${t('zoneForm.dragHint')}`}
      </p>

      {/* Save / Discard / Delete */}
      <div className="flex items-center gap-1.5">
        <Button
          variant="unstyled"
          type="button"
          onClick={onSave}
          className="inline-flex items-center justify-center gap-1 rounded border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 transition-colors h-7 flex-1 text-[11px] font-medium"
          title={t('zoneForm.saveTitle')}
        >
          <Check className="h-3 w-3" />
          {t('zoneForm.save')}
        </Button>
        <Button
          variant="unstyled"
          type="button"
          onClick={onDiscard}
          className="inline-flex items-center justify-center gap-1 rounded border border-border bg-surface text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors h-7 px-3 text-[11px] font-medium"
          title={t('zoneForm.discardTitle')}
        >
          <X className="h-3 w-3" />
          {t('zoneForm.discard')}
        </Button>
      </div>
      <Button
        variant="unstyled"
        type="button"
        onClick={onDelete}
        className={`${BTN_COMPACT_DANGER} w-full`}
      >
        <Trash2 className="h-3 w-3" />
        {t('zoneForm.delete')}
      </Button>
    </div>
  )
}
