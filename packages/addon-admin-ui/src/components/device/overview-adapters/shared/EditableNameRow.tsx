/**
 * Name field for Customize's identity block. The row only reports edits;
 * the page's one Save persists them. There is no per-field save.
 */
import { InfoRow } from './overview-primitives'

export function EditableNameRow({
  initialName,
  label = 'Name',
  layout = 'inline',
  bound,
}: {
  readonly deviceId: number
  readonly initialName: string
  readonly label?: string
  readonly layout?: 'inline' | 'stacked'
  readonly bound: {
    readonly value: string
    readonly onChange: (value: string) => void
  }
}) {
  return (
    <InfoRow
      label={label}
      layout={layout}
      value={
        <input
          type="text"
          value={bound.value}
          aria-label={label}
          placeholder={initialName}
          onChange={(e) => bound.onChange(e.target.value)}
          className="flex-1 min-w-0 w-full px-1.5 py-0.5 text-[11px] bg-background border border-border rounded focus:outline-none focus:border-primary"
        />
      }
    />
  )
}
