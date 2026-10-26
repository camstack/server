/**
 * One Consumables row per item, drawn by the item's FORM (D915) — the kind
 * still decides which direction is bad, through the one kind-aware
 * `consumableItemLevel` mapping, so a row's tone and the section's summary
 * always agree:
 *  - `part`    — a wear bar, the remaining time and a "Replaced" reset;
 *  - `tank`    — a vertical fill gauge (a supply warns low/empty, waste full);
 *  - `product` — a package icon, a stepped level and "refill" wording;
 *  - `bin`     — a vertical fill gauge that warns when full.
 * Every state is also said in words — never by colour alone.
 */
import type { JSX } from 'react'
import { Package } from 'lucide-react'
import {
  consumableFormOf,
  formatReading,
  type ConsumableItem,
  type ConsumableRemaining,
} from '@camstack/types'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { Button } from '../../primitives/button'
import {
  ConsumableLevelBadge,
  type ConsumableLevel,
  consumableItemLevel,
  consumableLevelBarClass,
} from '../consumable-level-badge'

/** `value` null = unknown (D393) — renders an em-dash, never a fake `0`. */
function formatRemaining(t: UiTextFn, r: ConsumableRemaining): string {
  if (r.value === null) return '—'
  if (r.kind === 'count') {
    return t(
      'uiLibrary.consumablesPanel.cycles',
      { one: '{{count}} cycle', other: '{{count}} cycles' },
      { count: r.value },
    )
  }
  const rendered = formatReading({ value: r.value, quantity: 'duration', precision: 0 })
  return rendered.unit.length === 0 ? rendered.text : `${rendered.text} ${rendered.unit}`
}

/** Format a ms-epoch as a compact local date for the "replaced" hint. */
function formatResetAt(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return ''
  }
}

function needsAttention(level: ConsumableLevel): boolean {
  return level === 'low' || level === 'empty' || level === 'full'
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

export interface ConsumableRowProps {
  readonly item: ConsumableItem
  readonly busy: boolean
  readonly canReset: boolean
  readonly onReset: (key: string) => void
}

interface RowFrameProps {
  readonly item: ConsumableItem
  readonly warn: boolean
  readonly children: JSX.Element | readonly JSX.Element[]
}

function RowFrame({ item, warn, children }: RowFrameProps): JSX.Element {
  return (
    <div
      data-form={consumableFormOf(item)}
      className={`flex gap-2.5 rounded-md border p-3 ${
        warn ? 'border-warning/40 bg-warning/5' : 'border-border-subtle'
      }`}
    >
      {children}
    </div>
  )
}

function RowLabel({ item, warn }: { readonly item: ConsumableItem; readonly warn: boolean }) {
  return (
    <span className={`truncate text-xs font-semibold ${warn ? 'text-warning' : 'text-foreground'}`}>
      {item.label}
    </span>
  )
}

/** A wear part: bar + %, or its verdict; remaining time; the reset. */
function PartRow({ item, busy, canReset, onReset }: ConsumableRowProps): JSX.Element {
  const t = useUiText()
  const level = consumableItemLevel(item)
  const warn = needsAttention(level)
  return (
    <RowFrame item={item} warn={warn}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <RowLabel item={item} warn={warn} />
        {item.level !== null ? (
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
              <div
                className={`h-full rounded-full ${consumableLevelBarClass(level)} transition-all`}
                // ui-check-ok: computed geometry — the fill's width is the item's %
                style={{ width: `${clampPercent(item.level)}%` }}
              />
            </div>
            <span className="text-[10px] font-medium tabular-nums text-foreground-subtle">
              {Math.round(item.level)}%
            </span>
          </div>
        ) : (
          <ConsumableLevelBadge
            level={level}
            size="sm"
            className="w-fit"
            label={
              item.status === 'replace'
                ? t('uiLibrary.consumablesPanel.replace', 'Replace')
                : undefined
            }
          />
        )}
        {item.remaining && (
          <span className="text-[10px] font-medium tabular-nums text-foreground-subtle">
            {formatRemaining(t, item.remaining)}
          </span>
        )}
        {item.lastResetAt !== null && (
          <span className="text-[10px] text-foreground-subtle">
            {t('uiLibrary.consumablesPanel.replacedOn', 'Replaced {{date}}', {
              date: formatResetAt(item.lastResetAt),
            })}
          </span>
        )}
        {/* Under the reading, so a narrow card never truncates the part's name. */}
        {item.resettable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() => onReset(item.key)}
            disabled={busy || !canReset}
          >
            {t('uiLibrary.consumablesPanel.replaced', 'Replaced')}
          </Button>
        )}
      </div>
    </RowFrame>
  )
}

/** A tank or a bin: a vertical gauge filled from the bottom, then the % or the verdict. */
function GaugeRow({ item }: { readonly item: ConsumableItem }): JSX.Element {
  const level = consumableItemLevel(item)
  const warn = needsAttention(level)
  return (
    <RowFrame item={item} warn={warn}>
      <div
        className="relative h-10 w-3 shrink-0 overflow-hidden rounded-sm border border-border bg-surface-hover"
        data-testid="consumable-gauge"
      >
        {item.level !== null && (
          <div
            className={`absolute inset-x-0 bottom-0 ${consumableLevelBarClass(level)} transition-all`}
            // ui-check-ok: computed geometry — the gauge's fill height is the item's %
            style={{ height: `${clampPercent(item.level)}%` }}
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <RowLabel item={item} warn={warn} />
        <div className="flex items-center gap-2">
          <ConsumableLevelBadge level={level} size="sm" className="w-fit" />
          {item.level !== null && (
            <span className="text-[10px] font-medium tabular-nums text-foreground-subtle">
              {Math.round(item.level)}%
            </span>
          )}
        </div>
      </div>
    </RowFrame>
  )
}

/** How many of the three steps a product's level fills. */
const PRODUCT_STEPS: Readonly<Record<'ok' | 'low' | 'empty' | 'full' | 'unknown', number>> = {
  full: 3,
  ok: 3,
  low: 1,
  empty: 0,
  unknown: 0,
}
const STEP_INDEXES = [0, 1, 2] as const

/** The refill wording a product's level reads as. */
function productLabel(level: ConsumableLevel, t: UiTextFn): string | undefined {
  if (level === 'low') return t('uiLibrary.consumablesPanel.refillSoon', 'Refill soon')
  if (level === 'empty') return t('uiLibrary.consumablesPanel.refillNow', 'Refill now')
  return undefined
}

/** A product bought and refilled: package icon, three steps, "refill". */
function ProductRow({ item }: { readonly item: ConsumableItem }): JSX.Element {
  const t = useUiText()
  const level = consumableItemLevel(item)
  const warn = needsAttention(level)
  const filled = PRODUCT_STEPS[level ?? 'unknown']
  return (
    <RowFrame item={item} warn={warn}>
      <Package
        className={`mt-0.5 h-4 w-4 shrink-0 ${warn ? 'text-warning' : 'text-foreground-subtle'}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <RowLabel item={item} warn={warn} />
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-0.5" data-testid="consumable-steps" data-filled={filled}>
            {STEP_INDEXES.map((i) => (
              <span
                key={i}
                className={`h-1.5 w-3 rounded-full ${
                  i < filled ? consumableLevelBarClass(level) : 'bg-surface-hover'
                }`}
              />
            ))}
          </div>
          <ConsumableLevelBadge
            level={level}
            size="sm"
            className="whitespace-nowrap"
            label={productLabel(level, t)}
          />
        </div>
      </div>
    </RowFrame>
  )
}

/** The row for an item, chosen by its form. */
export function ConsumableRow(props: ConsumableRowProps): JSX.Element {
  switch (consumableFormOf(props.item)) {
    case 'part':
      return <PartRow {...props} />
    case 'tank':
    case 'bin':
      return <GaugeRow item={props.item} />
    case 'product':
      return <ProductRow item={props.item} />
  }
}
