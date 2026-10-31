import { useTranslation } from 'react-i18next'
/**
 * FlowStrip — read-only, responsive visualization of the capability flow
 * for one node. Renders the well-known pipeline as a stepper:
 *
 *   decode → motion → detect → audio-analyze → audio-classify
 *           → analyze → notify
 *
 * Each step shows the `(capName, addonId)` pair currently bound on the
 * node. Clicking a step calls `onStepClick(capName)` — the host scrolls
 * to the matching binding row in the `CapabilityBindings` form below.
 *
 * Responsive strategy (self-contained, zero layout libraries — pure flex
 * + Tailwind container queries):
 *   - The component's own root is a `@container/flowstrip`, so it reflows
 *     against ITS OWN width, independent of where it is mounted.
 *   - Narrow (< `@lg`, ~512px): a VERTICAL stepper — full-width steps
 *     stacked top→bottom with down-arrow connectors. Never overflows.
 *   - Wide (≥ `@lg`): the horizontal L→R data flow with right-arrow
 *     connectors, wrapping tidily to further rows if space runs short.
 * Both arrow glyphs are always in the DOM; container-query variants show
 * exactly one, so the page body never scrolls horizontally.
 */
import type { ReactNode } from 'react'
import { Video, Activity, Brain, LineChart, Bell, AudioLines, Music } from 'lucide-react'
import { Button } from '@camstack/ui-library'

export interface FlowStep {
  readonly capName: string
  readonly label: string
  readonly addonId: string | null
  readonly icon: ReactNode
}

/**
 * The canonical "well-known" capability flow rendered by the strip.
 * Order matters — it's the L→R data flow through the pipeline:
 *
 *   decode → motion → detect → audio-analyze → audio-classify
 *           → analyze → notify
 *
 * Video caps and audio caps live in parallel sub-flows but share the
 * same picker UI. Each entry becomes a row in the capability-bindings
 * table on every node's Pipeline tab.
 */
export const KNOWN_FLOW_CAPS = [
  {
    capName: 'decoder',
    labelKey: 'pipeline.flowStrip.decode',
    icon: <Video className="h-3.5 w-3.5" />,
  },
  {
    capName: 'motion-detection',
    labelKey: 'pipeline.flowStrip.motion',
    icon: <Activity className="h-3.5 w-3.5" />,
  },
  {
    capName: 'pipeline-executor',
    labelKey: 'pipeline.flowStrip.detect',
    icon: <Brain className="h-3.5 w-3.5" />,
  },
  {
    capName: 'audio-analyzer',
    labelKey: 'pipeline.flowStrip.audioAnalyze',
    icon: <AudioLines className="h-3.5 w-3.5" />,
  },
  {
    capName: 'audio-classifier',
    labelKey: 'pipeline.flowStrip.audioClassify',
    icon: <Music className="h-3.5 w-3.5" />,
  },
  {
    capName: 'analysis-pipeline',
    labelKey: 'pipeline.flowStrip.analyze',
    icon: <LineChart className="h-3.5 w-3.5" />,
  },
  {
    capName: 'notification-output',
    labelKey: 'pipeline.flowStrip.notify',
    icon: <Bell className="h-3.5 w-3.5" />,
  },
] as const

// Re-export the canonical capability rosters from `@camstack/types`
// (single source of truth shared between backend + admin-ui). The list
// `KNOWN_FLOW_CAPS` above is the UI-only augmentation that attaches a
// label + icon to each flow cap; the raw name lists come from types.
export {
  PIPELINE_FLOW_CAPABILITY_NAMES as PIPELINE_CAPABILITY_NAMES,
  PIPELINE_OWNER_CAPABILITY_NAMES,
} from '@camstack/types'

interface FlowStripProps {
  readonly steps: readonly FlowStep[]
  readonly onStepClick?: (capName: string) => void
}

interface FlowStepBoxProps {
  readonly step: FlowStep
  readonly onClick?: (capName: string) => void
}

/**
 * A single tappable step. Bound steps read as solid/active (primary-tinted
 * icon badge, addon id in foreground); unbound steps use a dashed, muted
 * treatment. Full-width in the vertical layout, auto-width in the row
 * layout. Generous padding keeps it a comfortable tap target on mobile.
 */
function FlowStepBox({ step, onClick }: FlowStepBoxProps) {
  const { t } = useTranslation()
  const bound = step.addonId !== null
  return (
    <Button
      variant="unstyled"
      type="button"
      onClick={() => onClick?.(step.capName)}
      aria-label={t('pipeline.flowStrip.stepAria', {
        label: step.label,
        state: bound ? step.addonId : t('pipeline.flowStrip.unbound'),
      })}
      className={[
        'group flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
        '@lg/flowstrip:w-auto @lg/flowstrip:min-w-[132px] @lg/flowstrip:flex-none',
        bound
          ? 'border-border bg-surface hover:border-primary/60 hover:bg-surface-hover'
          : 'border-dashed border-border/70 bg-surface/50 hover:border-primary/50 hover:bg-surface-hover',
      ].join(' ')}
    >
      <span
        className={[
          'flex h-7 w-7 flex-none items-center justify-center rounded-md transition-colors',
          bound
            ? 'bg-primary/10 text-primary group-hover:bg-primary/20'
            : 'bg-surface-hover text-foreground-subtle',
        ].join(' ')}
        aria-hidden="true"
      >
        {step.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
          {step.label}
        </span>
        <span className="block w-full truncate text-[11px]">
          {bound ? (
            <span className="text-foreground">{step.addonId}</span>
          ) : (
            <span className="italic text-foreground-subtle">{t('pipeline.flowStrip.unbound')}</span>
          )}
        </span>
      </span>
    </Button>
  )
}

/**
 * Connector between two steps. Both glyphs are always rendered; the
 * container-query variants reveal exactly one so the strip flows down in
 * the narrow (vertical) layout and rightward in the wide (row) layout.
 */
function FlowConnector() {
  return (
    <span
      className="flex items-center justify-center py-1 text-foreground-subtle @lg/flowstrip:px-0.5 @lg/flowstrip:py-0"
      aria-hidden="true"
    >
      {/* Down arrow — vertical (narrow) layout only */}
      <svg width="8" height="14" viewBox="0 0 8 14" className="block @lg/flowstrip:hidden">
        <path
          d="M4 0 L4 11 M1 8 L4 11 L7 8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {/* Right arrow — horizontal (wide) layout only */}
      <svg width="14" height="8" viewBox="0 0 14 8" className="hidden @lg/flowstrip:block">
        <path
          d="M0 4 L11 4 M8 1 L11 4 L8 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

export function FlowStrip({ steps, onStepClick }: FlowStripProps) {
  return (
    <div className="@container/flowstrip w-full">
      <ol className="flex list-none flex-col items-stretch gap-0 @lg/flowstrip:flex-row @lg/flowstrip:flex-wrap @lg/flowstrip:items-center @lg/flowstrip:gap-x-1 @lg/flowstrip:gap-y-2">
        {steps.map((step, index) => (
          <li
            key={step.capName}
            className="flex flex-col items-stretch @lg/flowstrip:flex-row @lg/flowstrip:items-center"
          >
            <FlowStepBox step={step} onClick={onStepClick} />
            {index < steps.length - 1 && <FlowConnector />}
          </li>
        ))}
      </ol>
    </div>
  )
}
