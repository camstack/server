import type { ReactElement } from 'react'
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from '../../../primitives/dropdown'
import { CARD_ICONS, type CardGlyph } from '../icons'
import { useCardGating } from '../shell/gating'
import { cardButtonClass } from './CardButton'
import { CardIcon } from './CardIcon'

export interface MenuOption {
  readonly id: string
  readonly label: string
  readonly glyph?: CardGlyph
}

export interface MenuButtonProps {
  readonly options: readonly MenuOption[]
  readonly value: string | null
  readonly onChange: (id: string) => void
  readonly ariaLabel: string
  readonly disabled?: boolean
  readonly testId?: string
  /**
   * `stacked`: the glyph over the whole label, the chevron under it — for a
   * scene's narrow side column, where an inline label would be cut. Default
   * `inline`.
   */
  readonly layout?: 'inline' | 'stacked'
}

/** A button that names the current choice and opens the list of the others. */
export function MenuButton({
  options,
  value,
  onChange,
  ariaLabel,
  disabled,
  testId,
  layout = 'inline',
}: MenuButtonProps): ReactElement {
  const gating = useCardGating()
  const current = options.find((o) => o.id === value) ?? null
  return (
    <Dropdown>
      <DropdownTrigger
        aria-label={ariaLabel}
        disabled={disabled === true || gating.blocked}
        title={gating.blocked ? (gating.reason ?? undefined) : undefined}
        data-testid={testId}
        data-layout={layout}
        className={cardButtonClass(
          'default',
          gating.blocked,
          layout === 'stacked' ? 'flex-col gap-0.5 whitespace-normal leading-tight' : undefined,
        )}
      >
        {current?.glyph === undefined ? null : <CardIcon glyph={current.glyph} />}
        <span className={layout === 'stacked' ? 'text-center' : 'min-w-0 truncate'}>
          {current?.label ?? value ?? ariaLabel}
        </span>
        <CardIcon glyph="menu" className="h-3 w-3" />
      </DropdownTrigger>
      <DropdownContent>
        {options.map((o) => (
          <DropdownItem
            key={o.id}
            role="menuitemradio"
            aria-checked={o.id === value}
            {...(o.glyph === undefined ? {} : { icon: CARD_ICONS[o.glyph] })}
            onClick={() => onChange(o.id)}
          >
            {o.label}
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  )
}
