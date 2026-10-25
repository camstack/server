/**
 * phase-config — canonical visual config for CameraPhase values.
 *
 * Single source of truth for label, color classes, dot class, and
 * lucide icon name. Every UI surface (PhaseBadge, CameraStatusStrip,
 * CameraAssignmentsTable, DeviceDetail, OverviewTab, NodeLiveTab)
 * imports from here instead of hardcoding phase → style mappings.
 *
 * Icon components are NOT imported here (would pull lucide-react into
 * the config module). Consumers import the icon by name themselves:
 *   `import { [cfg.icon] } from 'lucide-react'`
 * or use the provided `PhaseIcon` component from `./phase-icon.tsx`.
 */
import type { CameraPhase } from '@camstack/types'
import { defaultUiText, type UiTextFn } from '../contexts/ui-text'

export interface PhaseVisual {
  /** Human-readable label (e.g. "Active", "Load-Shed"), resolved through the host's translator. */
  readonly label: string
  /** Tailwind text color class (e.g. "text-success"). */
  readonly textColor: string
  /** Tailwind border+bg classes for pill/badge containers. */
  readonly badgeClass: string
  /** Tailwind class for the status dot (circle indicator). */
  readonly dotClass: string
  /** Lucide icon name to use for this phase. */
  readonly icon: 'Activity' | 'Eye' | 'AlertTriangle' | 'PauseCircle' | 'PowerOff'
}

/** A table row: the label is a catalogue key + English fallback, resolved by the consumer. */
export interface PhaseStyle extends Omit<PhaseVisual, 'label'> {
  readonly labelKey: string
  readonly labelFallback: string
}

export const PHASE_CONFIG: Record<CameraPhase, PhaseStyle> = {
  idle: {
    labelKey: 'uiLibrary.phase.idle',
    labelFallback: 'Idle',
    textColor: 'text-foreground-subtle',
    badgeClass: 'border-border bg-surface-hover text-foreground-subtle',
    dotClass: 'bg-gray-400',
    icon: 'PowerOff',
  },
  active: {
    labelKey: 'uiLibrary.phase.active',
    labelFallback: 'Active',
    textColor: 'text-success',
    badgeClass: 'border-success/40 bg-success/10 text-success',
    dotClass: 'bg-red-500 animate-pulse',
    icon: 'Activity',
  },
  watching: {
    labelKey: 'uiLibrary.phase.watching',
    labelFallback: 'Watching',
    textColor: 'text-foreground-subtle',
    badgeClass: 'border-border bg-surface-hover text-foreground-subtle',
    dotClass: 'bg-emerald-500',
    icon: 'Eye',
  },
  'load-shed': {
    labelKey: 'uiLibrary.phase.loadShed',
    labelFallback: 'Load-Shed',
    textColor: 'text-amber-500',
    badgeClass: 'border-amber-500/40 bg-amber-500/10 text-amber-500',
    dotClass: 'bg-amber-500',
    icon: 'AlertTriangle',
  },
  paused: {
    labelKey: 'uiLibrary.phase.paused',
    labelFallback: 'Paused',
    textColor: 'text-gray-400',
    badgeClass: 'border-gray-500/40 bg-gray-500/10 text-gray-400',
    dotClass: 'bg-gray-400',
    icon: 'PauseCircle',
  },
}

/** Look up phase config with a safe fallback to `watching` for unknown values. */
export function getPhaseVisual(phase: string, t: UiTextFn = defaultUiText): PhaseVisual {
  const { labelKey, labelFallback, ...style } =
    PHASE_CONFIG[phase as CameraPhase] ?? PHASE_CONFIG.watching
  return { ...style, label: t(labelKey, labelFallback) }
}
