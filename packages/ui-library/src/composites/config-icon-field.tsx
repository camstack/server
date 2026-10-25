/**
 * The control behind a `type: 'icon'` settings field (D780).
 *
 * The shared `<IconPicker>` over the icon catalog (D854) — the same control
 * and the same keys the device and room pickers use. An icon field always draws something, so clearing is "back to
 * the field's default", and a stored value the catalog does not know (a
 * free-text lucide name from before D780) is drawn as that default.
 */
import { resolveIconKey } from '@camstack/types'
import { ShieldCheck } from 'lucide-react'
import { useDisplayIconResolver } from './icon-glyphs'
import { IconPicker, type IconPickerLabels } from './icon-picker'
import { type JSX } from 'react'

export interface ConfigIconFieldControlProps {
  /** The field's label — names the picker for assistive tech. */
  readonly label: string
  /** The stored value (anything — only a vocabulary key is honoured). */
  readonly value: unknown
  /** The field's default key; `''` when the schema declares none. */
  readonly defaultKey: string
  readonly disabled?: boolean
  readonly onChange: (key: string) => void
}

function labelsFor(label: string): IconPickerLabels {
  return {
    trigger: `Choose an icon for ${label}`,
    panel: `${label} icon`,
    searchPlaceholder: 'Search icons',
    clear: 'Default icon',
    noMatches: 'No icon matches',
  }
}

export function ConfigIconFieldControl({
  label,
  value,
  defaultKey,
  disabled,
  onChange,
}: ConfigIconFieldControlProps): JSX.Element {
  const resolveDisplayIcon = useDisplayIconResolver()
  const key = resolveIconKey(value, defaultKey)
  const DefaultGlyph = resolveDisplayIcon(defaultKey) ?? ShieldCheck
  return (
    <div className="flex items-center gap-2">
      <IconPicker
        value={key === '' ? null : key}
        onPick={(next) => onChange(next ?? defaultKey)}
        fallbackGlyph={DefaultGlyph}
        labels={labelsFor(label)}
        disabled={disabled}
      />
      <span className="text-[11px] text-foreground-subtle font-mono">{key}</span>
    </div>
  )
}
