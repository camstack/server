/**
 * The icon of ONE device.
 *
 * The control itself is `IconPicker` from ui-library — the same one the room
 * picker uses, over the same vocabulary and the same search. What is left here
 * is the device's half: the glyph table, and what clearing means.
 *
 * Clearing is INHERIT, not "none": a device with no override still draws
 * something (the operator's role default, the role's own glyph, the type), so
 * the clear tile wears that inherited glyph and names it. The room picker
 * clears to nothing and wears `Ban` for exactly that reason — same control,
 * two honest answers.
 *
 * The picker edits a FORM value: the write is the section's Save, shared with
 * the label and the rest of the override, which the server stores as one
 * object. `''` is this form's spelling of "no override"; the shared control
 * speaks `null`, and the translation happens here rather than teaching the
 * control one consumer's encoding.
 */
import { IconPicker, type IconPickerLabels } from '@camstack/ui-library'
import { type IconCategoryId, iconCategoryLabel } from '@camstack/types'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface DisplayIconPickerProps {
  /** The device this picker belongs to — for the accessible names. */
  readonly deviceName: string
  /** The catalog key in the form, or `''` for "inherit". */
  readonly value: string
  /** What the row draws with no override, and the name of that answer. */
  readonly inheritedIcon: LucideIcon
  readonly inheritedLabel: string
  readonly disabled: boolean
  readonly onChange: (value: string) => void
}

export function DisplayIconPicker({
  deviceName,
  value,
  inheritedIcon,
  inheritedLabel,
  disabled,
  onChange,
}: DisplayIconPickerProps) {
  const { t } = useTranslation()

  const labels: IconPickerLabels = {
    trigger: t('deviceDisplay.pickIcon', { name: deviceName }),
    panel: t('deviceDisplay.iconFor', { name: deviceName }),
    searchPlaceholder: t('deviceDisplay.iconSearchPlaceholder'),
    clear: inheritedLabel,
    noMatches: t('deviceDisplay.iconNoMatches'),
  }
  // Titles come from the i18n catalog; an id nobody translated yet falls back to the derived English one.
  const categoryLabel = (category: IconCategoryId): string =>
    t(`deviceDisplay.iconCategory.${category}`, { defaultValue: iconCategoryLabel(category) })

  return (
    <div className="flex items-center gap-2">
      <IconPicker
        value={value === '' ? null : value}
        onPick={(key) => onChange(key ?? '')}
        categoryLabel={categoryLabel}
        fallbackGlyph={inheritedIcon}
        labels={labels}
        disabled={disabled}
      />
      <span className="text-[11px] text-foreground-subtle">
        {value !== '' ? value : inheritedLabel}
      </span>
    </div>
  )
}
