/**
 * card-primitives — tiny shared building blocks for the camera pipeline
 * cards: labelled block shell, key→value rows, chips, override markers.
 *
 * All values render in a tabular mono style so the roster reads like a
 * control-room console instead of prose.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

// ---------------------------------------------------------------------------
// Block shell
// ---------------------------------------------------------------------------

export interface CardBlockProps {
  readonly title: string
  readonly children: ReactNode
}

/** One labelled cell inside the card's hairline grid. */
export function CardBlock({ title, children }: CardBlockProps) {
  return (
    <div className="bg-background px-3.5 py-3 min-w-0">
      <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-foreground-subtle mb-2">
        {title}
      </div>
      <div className="flex flex-col gap-1 min-w-0">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Key → value row
// ---------------------------------------------------------------------------

export interface KVRowProps {
  readonly label: string
  readonly children: ReactNode
  /** Amber marker: a device-level override is active for this parameter. */
  readonly overridden?: boolean
}

export function KVRow({ label, children, overridden = false }: KVRowProps) {
  return (
    <div className="flex items-baseline gap-2 text-[11px] leading-snug min-w-0">
      <span className="text-foreground-subtle shrink-0 w-24 truncate" title={label}>
        {label}
      </span>
      <span className="font-mono tabular-nums text-foreground min-w-0 truncate flex-1">
        {children}
      </span>
      {overridden && <OverrideDot />}
    </div>
  )
}

/** Amber dot marking a per-camera settings override. */
export function OverrideDot() {
  const { t } = useTranslation()
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-warning shrink-0 self-center"
      title={t('cameras.cardPrimitives.deviceLevelOverrideActive', 'Device-level override active')}
      aria-label={t(
        'cameras.cardPrimitives.deviceLevelOverrideActive',
        'Device-level override active',
      )}
      role="img"
    />
  )
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export type ChipTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

const CHIP_TONE_CLASS: Record<ChipTone, string> = {
  neutral: 'border-border text-foreground-muted',
  success: 'border-success/40 text-success',
  warning: 'border-warning/40 text-warning',
  danger: 'border-danger/40 text-danger',
  info: 'border-info/40 text-info',
}

export interface ChipProps {
  readonly tone?: ChipTone
  readonly children: ReactNode
  readonly title?: string
}

export function Chip({ tone = 'neutral', children, title }: ChipProps) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium leading-tight whitespace-nowrap ${CHIP_TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Empty / stage-inactive placeholder
// ---------------------------------------------------------------------------

export interface StageInactiveProps {
  readonly children: ReactNode
}

export function StageInactive({ children }: StageInactiveProps) {
  return <div className="text-[11px] text-foreground-subtle italic">{children}</div>
}
