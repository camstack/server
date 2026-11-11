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
}

/** A button that names the current choice and opens the list of the others. */
export function MenuButton({
  options,
  value,
  onChange,
  ariaLabel,
  disabled,
  testId,
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
        className={cardButtonClass('default', gating.blocked)}
      >
        {current?.glyph === undefined ? null : <CardIcon glyph={current.glyph} />}
        <span className="min-w-0 truncate">{current?.label ?? value ?? ariaLabel}</span>
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
