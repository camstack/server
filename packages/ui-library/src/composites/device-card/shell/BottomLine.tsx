import { type ReactElement, useState } from 'react'
import { cn } from '../../../lib/cn'
import { useUiText } from '../../../contexts/ui-text'
import { Button } from '../../../primitives/button'
import { ButtonGroup } from '../parts/ButtonGroup'
import { CardButton } from '../parts/CardButton'
import { CardIcon } from '../parts/CardIcon'
import { CardGatingProvider, useCardGating } from './gating'
import type { ConsumableLevel } from '@dominevo/types'
import type { UiTextFn } from '../../../contexts/ui-text'
import {
  ConsumableLevelBadge,
  consumableItemLevel,
  consumableLevelBarClass,
  consumableLevelLabel,
} from '../../consumable-level-badge'
import type { CardConsumable, CardSupply, CardSupplyAction } from './model'
import { usePopover } from './use-popover'

const CHIP = 'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs'
const POP =
  'absolute bottom-full z-20 mb-2 flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 shadow-lg'

/** Why the card cannot be commanded; nothing when it can. */
export interface ReasonLineProps {
  /** Why the last command failed; the gating reason wins when both exist. */
  readonly notice?: string | null
}

export function ReasonLine({ notice = null }: ReasonLineProps): ReactElement | null {
  const gating = useCardGating()
  const text = gating.reason ?? notice
  if (text === null) return null
  return (
    <p
      data-testid="dc-reason"
      role={gating.reason === null ? 'alert' : undefined}
      className="order-first w-full text-xs text-danger"
    >
      {text}
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
            <ButtonGroup
              mode="actions"
              ariaLabel={t('uiLibrary.deviceCard.supply.title', 'Upstream supply')}
              testId="dc-supply-actions"
              value={null}
              onChange={(id) => {
                if (id === 'on' || id === 'off' || id === 'restart') onAction(id)
              }}
              options={[
                ...(supply.settable === false
                  ? []
                  : [
                      {
                        id: 'on',
                        glyph: 'power' as const,
                        label: t('uiLibrary.deviceCard.turnOn', 'Turn on'),
                        disabled: busy || supply.state === 'on',
                      },
                      {
                        id: 'off',
                        glyph: 'power' as const,
                        label: t('uiLibrary.deviceCard.turnOff', 'Turn off'),
                        disabled: busy || supply.state === 'off',
                      },
                    ]),
                {
                  id: 'restart',
                  glyph: 'restart' as const,
                  label: t('uiLibrary.deviceCard.supply.restart', 'Restart'),
                  disabled: busy,
                },
              ]}
            />
          </CardGatingProvider>
        </div>
      ) : null}
    </div>
  )
}

export interface ConsumablesButtonProps {
  readonly items: readonly CardConsumable[]
  /** Bound to `consumables` but the slice has not landed: loading, never "none" (D315). */
  readonly loading?: boolean
  /** A promise lets the row disable its Reset while the call is in flight. */
  readonly onReset: (key: string) => void | PromiseLike<unknown>
}

/** The kind-aware level of a row; absent = a wear part read from its percent. */
const levelOf = (c: CardConsumable): ConsumableLevel | null =>
  c.level !== undefined ? c.level : consumableItemLevel({ level: c.percent, status: null })

const SEVERITY: Readonly<Record<'empty' | 'full' | 'low', number>> = {
  empty: 3,
  full: 2,
  low: 1,
}
const isAttention = (l: ConsumableLevel | null): l is 'empty' | 'full' | 'low' =>
  l === 'empty' || l === 'full' || l === 'low'

const wordOf = (c: CardConsumable, t: UiTextFn): string =>
  c.levelWord ?? consumableLevelLabel(levelOf(c), t)

/** The reading drawn by the item's form: a wear bar, a vertical gauge, or three steps. */
function ConsumableMeter({ c }: { readonly c: CardConsumable }): ReactElement {
  const level = levelOf(c)
  const fill = consumableLevelBarClass(level)
  const percent = c.percent === null ? null : Math.min(100, Math.max(0, c.percent))
  if (c.form === 'tank' || c.form === 'bin') {
    return (
      <span
        data-testid="dc-consumable-gauge"
        className="relative h-6 w-2.5 justify-self-center overflow-hidden rounded-sm border border-border bg-surface-hover"
      >
        {percent === null ? null : (
          <span
            className={cn('absolute inset-x-0 bottom-0', fill)}
            // ui-check-ok: computed geometry — the gauge's fill height is the item's %
            style={{ height: `${percent}%` }}
          />
        )}
      </span>
    )
  }
  if (c.form === 'product') {
    const filled = level === 'low' ? 1 : level === 'empty' || level === null ? 0 : 3
    return (
      <span className="flex gap-0.5" data-testid="dc-consumable-steps" data-filled={filled}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn('h-1.5 w-3 rounded-full', i < filled ? fill : 'bg-surface-hover')}
          />
        ))}
      </span>
    )
  }
  return percent === null ? (
    <span />
  ) : (
    <span
      role="meter"
      aria-label={c.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-hover"
    >
      <span
        className={cn('block h-full rounded-full', fill)}
        // ui-check-ok: computed geometry — the fill's width is the item's %
        style={{ width: `${percent}%` }}
      />
    </span>
  )
}

/**
 * The consumables: one chip that warns about the worst item (a part running
 * out, a full bin) and opens the full list. Unknown is never ok (D393) and
 * "none" is only said once the provider answered (D315).
 */
export function ConsumablesButton({
  items,
  loading = false,
  onReset,
}: ConsumablesButtonProps): ReactElement {
  const t = useUiText()
  const pop = usePopover()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const reset = (key: string): void => {
    setBusyKey(key)
    void Promise.resolve(onReset(key)).finally(() => setBusyKey(null))
  }
  const attention = items
    .filter((c) => isAttention(levelOf(c)))
    .sort((a, b) => {
      const la = levelOf(a)
      const lb = levelOf(b)
      const d = (isAttention(lb) ? SEVERITY[lb] : 0) - (isAttention(la) ? SEVERITY[la] : 0)
      return d !== 0 ? d : (a.percent ?? 0) - (b.percent ?? 0)
    })
  const worst = attention[0]
  const unknown = items.filter((c) => levelOf(c) === null).length
  const ok = items.length - attention.length - unknown
  if (loading || items.length === 0) {
    return (
      <div className="relative ml-auto" data-testid="dc-consumables">
        <span
          data-testid={loading ? 'dc-consumables-loading' : 'dc-consumables-empty'}
          className={cn(CHIP, 'border-transparent bg-surface-hover text-foreground-muted')}
        >
          <CardIcon glyph="consumables" className="h-3 w-3" />
          {loading
            ? t('uiLibrary.consumablesPanel.loading', 'Reading consumables…')
            : t('uiLibrary.consumablesPanel.empty', 'No consumables reported.')}
        </span>
      </div>
    )
  }
  return (
    <div ref={pop.rootRef} className="relative ml-auto" data-testid="dc-consumables">
      <Button
        type="button"
        variant="unstyled"
        aria-expanded={pop.open}
        data-low={worst !== undefined}
        onClick={pop.toggle}
        className={cn(CHIP, 'border-transparent bg-surface-hover text-foreground-muted')}
      >
        {worst !== undefined ? (
          <>
            <ConsumableLevelBadge
              level={levelOf(worst)}
              name={worst.label}
              label={wordOf(worst, t)}
              size="sm"
            />
            {attention.length > 1 ? <small>+{attention.length - 1}</small> : null}
          </>
        ) : (
          <>
            <CardIcon glyph="consumables" className="h-3 w-3" />
            {unknown === 0
              ? t('uiLibrary.deviceCard.consumables.ok', 'Consumables ok')
              : ok === 0
                ? t('uiLibrary.deviceCard.consumables.unknown', 'Consumables unknown')
                : t('uiLibrary.consumablesPanel.okAndUnknown', '{{ok}} OK · {{unknown}} unknown', {
                    ok,
                    unknown,
                  })}
          </>
        )}
        <CardIcon glyph="info" className="h-3 w-3 opacity-70" />
      </Button>
      {pop.open ? (
        <div
          role="dialog" // ui-check-ok: an anchored in-card popover (card anatomy), not a modal
          data-testid="dc-consumables-pop"
          className={cn(POP, 'right-0 max-h-52 w-72 max-w-[80vw] overflow-y-auto')}
        >
          <p className="text-xs font-semibold text-foreground">
            {t('uiLibrary.deviceCard.consumables.title', 'Consumables')}
          </p>
          {items.map((c) => (
            <div
              key={c.key}
              data-level={levelOf(c) ?? 'unknown'}
              className="grid grid-cols-[minmax(0,1fr)_48px_auto_auto] items-center gap-2 text-xs"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-foreground">
                  {c.label}
                  {c.note === undefined ? null : (
                    <small className="ml-1 text-foreground-muted">{c.note}</small>
                  )}
                </span>
                {c.detail === undefined ? null : (
                  <small className="truncate text-foreground-subtle">{c.detail}</small>
                )}
              </span>
              <ConsumableMeter c={c} />
              <ConsumableLevelBadge
                level={levelOf(c)}
                size="sm"
                className="justify-self-end whitespace-nowrap tabular-nums"
                label={
                  c.percent === null ? wordOf(c, t) : `${wordOf(c, t)} ${Math.round(c.percent)}%`
                }
              />
              {c.resetLabel === null ? (
                <span />
              ) : (
                <CardButton
                  className="min-h-7 px-2 py-1 text-xs"
                  disabled={busyKey === c.key || c.resetDisabled === true}
                  onClick={() => reset(c.key)}
                >
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
