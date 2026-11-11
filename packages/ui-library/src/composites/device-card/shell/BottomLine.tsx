import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { useUiText } from '../../../contexts/ui-text'
import { Button } from '../../../primitives/button'
import { CardButton } from '../parts/CardButton'
import { CardIcon } from '../parts/CardIcon'
import { LevelBar } from '../parts/LevelBar'
import { CardGatingProvider, useCardGating } from './gating'
import {
  type CardConsumable,
  type CardSupply,
  type CardSupplyAction,
  CONSUMABLE_LOW_PERCENT,
} from './model'
import { usePopover } from './use-popover'

const CHIP = 'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs'
const POP =
  'absolute bottom-full z-20 mb-2 flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 shadow-lg'

/** Why the card cannot be commanded; nothing when it can. */
export function ReasonLine(): ReactElement | null {
  const gating = useCardGating()
  if (gating.reason === null) return null
  return (
    <p data-testid="dc-reason" className="order-first w-full text-xs text-danger">
      {gating.reason}
    </p>
  )
}

export interface SupplyChipProps {
  readonly supply: CardSupply
  readonly readOnly: boolean
  readonly onAction: (action: CardSupplyAction) => void
}

/**
 * The switch that feeds the device. It is ANOTHER device, so an offline card
 * can still restart its supply; only a viewer without permission is refused.
 */
export function SupplyChip({ supply, readOnly, onAction }: SupplyChipProps): ReactElement {
  const t = useUiText()
  const pop = usePopover()
  const busy = supply.state === 'restarting'
  const stateWord =
    supply.state === 'on'
      ? t('uiLibrary.deviceCard.supply.on', 'on')
      : supply.state === 'off'
        ? t('uiLibrary.deviceCard.supply.off', 'off')
        : t('uiLibrary.deviceCard.supply.restarting', 'restarting…')
  return (
    <div ref={pop.rootRef} className="relative" data-testid="dc-supply">
      <Button
        type="button"
        variant="unstyled"
        aria-expanded={pop.open}
        onClick={pop.toggle}
        className={cn(CHIP, 'border-border bg-surface text-foreground hover:bg-surface-hover')}
      >
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            supply.state === 'off' ? 'bg-foreground-muted' : 'bg-success',
          )}
        />
        <CardIcon glyph="supply" className="h-3 w-3 text-foreground-muted" />
        {supply.name}
      </Button>
      {pop.open ? (
        <div
          role="dialog" // ui-check-ok: an anchored in-card popover (card anatomy), not a modal
          data-testid="dc-supply-pop"
          className={cn(POP, 'left-0 min-w-64')}
        >
          <p className="text-xs text-foreground-muted">
            {t('uiLibrary.deviceCard.supply.title', 'Upstream supply')} ·{' '}
            <b className="text-foreground">{stateWord}</b>
          </p>
          <CardGatingProvider
            value={{
              blocked: readOnly,
              reason: readOnly
                ? t(
                    'uiLibrary.deviceCard.reason.readOnly',
                    'Read only: you do not have permission to command it',
                  )
                : null,
            }}
          >
            <div className="flex flex-wrap gap-1.5">
              <CardButton
                glyph="power"
                disabled={busy || supply.state === 'on'}
                onClick={() => onAction('on')}
              >
                {t('uiLibrary.deviceCard.turnOn', 'Turn on')}
              </CardButton>
              <CardButton
                glyph="power"
                disabled={busy || supply.state === 'off'}
                onClick={() => onAction('off')}
              >
                {t('uiLibrary.deviceCard.turnOff', 'Turn off')}
              </CardButton>
              <CardButton glyph="restart" disabled={busy} onClick={() => onAction('restart')}>
                {t('uiLibrary.deviceCard.supply.restart', 'Restart')}
              </CardButton>
            </div>
          </CardGatingProvider>
        </div>
      ) : null}
    </div>
  )
}

export interface ConsumablesButtonProps {
  readonly items: readonly CardConsumable[]
  readonly onReset: (key: string) => void
}

const isLow = (c: CardConsumable): boolean =>
  c.percent !== null && c.percent <= CONSUMABLE_LOW_PERCENT

/** The consumables: one button that warns about the lowest, and the full list. */
export function ConsumablesButton({ items, onReset }: ConsumablesButtonProps): ReactElement {
  const t = useUiText()
  const pop = usePopover()
  const low = items.filter(isLow).sort((a, b) => (a.percent ?? 0) - (b.percent ?? 0))
  const worst = low[0]
  return (
    <div ref={pop.rootRef} className="relative ml-auto" data-testid="dc-consumables">
      <Button
        type="button"
        variant="unstyled"
        aria-expanded={pop.open}
        data-low={worst !== undefined}
        onClick={pop.toggle}
        className={cn(
          CHIP,
          worst === undefined
            ? 'border-transparent bg-surface-hover text-foreground-muted'
            : 'border-danger/40 bg-danger/10 text-danger',
        )}
      >
        <CardIcon glyph={worst === undefined ? 'consumables' : 'warning'} className="h-3 w-3" />
        {worst === undefined ? (
          t('uiLibrary.deviceCard.consumables.ok', 'Consumables ok')
        ) : (
          <>
            {worst.label} <b className="tabular-nums">{Math.round(worst.percent ?? 0)}%</b>
            {low.length > 1 ? <small>+{low.length - 1}</small> : null}
          </>
        )}
        <CardIcon glyph="info" className="h-3 w-3 opacity-70" />
      </Button>
      {pop.open ? (
        <div
          role="dialog" // ui-check-ok: an anchored in-card popover (card anatomy), not a modal
          data-testid="dc-consumables-pop"
          className={cn(POP, 'right-0 w-72 max-w-[80vw]')}
        >
          <p className="text-xs font-semibold text-foreground">
            {t('uiLibrary.deviceCard.consumables.title', 'Consumables')}
          </p>
          {items.map((c) => (
            <div
              key={c.key}
              className="grid grid-cols-[1fr_60px_36px_auto] items-center gap-2 text-xs"
            >
              <span className="min-w-0 truncate text-foreground">
                {c.label}
                {c.note === undefined ? null : (
                  <small className="ml-1 text-foreground-muted">{c.note}</small>
                )}
              </span>
              {c.percent === null ? (
                <span />
              ) : (
                <LevelBar percent={c.percent} low={isLow(c)} ariaLabel={c.label} />
              )}
              <span className="text-right tabular-nums text-foreground-muted">
                {c.percent === null ? '—' : `${Math.round(c.percent)}%`}
              </span>
              {c.resetLabel === null ? (
                <span />
              ) : (
                <CardButton className="min-h-7 px-2 py-1 text-xs" onClick={() => onReset(c.key)}>
                  {c.resetLabel}
                </CardButton>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
