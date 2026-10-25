/**
 * GateControl — whether ONE camera runs a step: Auto (the catalog default) /
 * On / Off. A per-camera, node-independent switch, written at once (it is not
 * part of the inspector's draft). `package-detection` is driven by package
 * zones and shows a badge instead.
 *
 * Segments are 36 px tall on a phone and 32 px from `md` up — the matrix this
 * replaced drew 26 px ones.
 */
import { cn } from '../../lib/cn'
import { useUiText } from '../../contexts/ui-text'
import { type JSX } from 'react'

/** The per-camera gate of a step. */
export type StepGate =
  | {
      readonly kind: 'gate'
      readonly effectiveOn: boolean
      readonly defaultOn: boolean
      readonly explicit: boolean
    }
  | { readonly kind: 'zone-driven' }

type GateChoice = 'auto' | 'on' | 'off'

export interface GateControlProps {
  readonly gate: StepGate
  readonly busy?: boolean
  /** `null` = back to the catalog default. */
  readonly onSet: (next: boolean | null) => void
}

function activeChoice(gate: Extract<StepGate, { kind: 'gate' }>): GateChoice {
  if (!gate.explicit) return 'auto'
  return gate.effectiveOn ? 'on' : 'off'
}

export function GateControl({ gate, busy = false, onSet }: GateControlProps): JSX.Element {
  const t = useUiText()
  if (gate.kind === 'zone-driven') {
    return (
      <span
        className="inline-flex items-center rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-[11px] font-medium text-violet-400"
        title={t(
          'uiLibrary.gateControl.zoneDrivenTitle',
          'Runs where this camera has package zones — set on the Zones tab',
        )}
      >
        {t('uiLibrary.gateControl.zones', 'Zones')}
      </span>
    )
  }
  const active = activeChoice(gate)
  const segment = (choice: GateChoice, label: string, value: boolean | null, on: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={active === choice}
      disabled={busy}
      onClick={() => onSet(value)}
      className={cn(
        'h-9 min-w-12 px-3 text-xs font-medium transition-colors md:h-8',
        active === choice ? on : 'text-foreground-subtle hover:bg-muted/60',
        busy && 'cursor-not-allowed opacity-50',
      )}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-2">
      <div
        role="radiogroup"
        aria-label={t('uiLibrary.gateControl.runsOnCamera', 'Runs on this camera')}
        title={t('uiLibrary.gateControl.catalogDefault', 'Catalog default: {{state}}', {
          state: gate.defaultOn
            ? t('uiLibrary.gateControl.on', 'on')
            : t('uiLibrary.gateControl.off', 'off'),
        })}
        className="inline-flex overflow-hidden rounded-md border border-border"
      >
        {segment(
          'auto',
          t('uiLibrary.gateControl.autoLabel', 'Auto'),
          null,
          'bg-primary/15 text-primary',
        )}
        <span className="w-px self-stretch bg-border" aria-hidden />
        {segment('on', t('uiLibrary.gateControl.onLabel', 'On'), true, 'bg-emerald-500 text-white')}
        <span className="w-px self-stretch bg-border" aria-hidden />
        {segment(
          'off',
          t('uiLibrary.gateControl.offLabel', 'Off'),
          false,
          'bg-foreground-subtle/70 text-white',
        )}
      </div>
      <span className="hidden text-[10px] text-foreground-subtle @3xl/inspector:inline">
        {t('uiLibrary.gateControl.defaultState', 'default: {{state}}', {
          state: gate.defaultOn
            ? t('uiLibrary.gateControl.on', 'on')
            : t('uiLibrary.gateControl.off', 'off'),
        })}
      </span>
    </div>
  )
}

/** The gate as a short list-row badge. */
export function GateBadge({ gate }: { readonly gate: StepGate }): JSX.Element {
  const t = useUiText()
  if (gate.kind === 'zone-driven') {
    return (
      <span className="shrink-0 text-[9px] font-semibold uppercase text-violet-400">
        {t('uiLibrary.gateControl.zonesBadge', 'zones')}
      </span>
    )
  }
  const on = gate.effectiveOn
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-px text-[9px] font-semibold uppercase',
        on ? 'bg-emerald-500/15 text-emerald-500' : 'bg-muted text-foreground-subtle',
        gate.explicit && 'ring-1 ring-inset ring-current',
      )}
      title={
        gate.explicit
          ? t('uiLibrary.gateControl.setForCamera', 'Set for this camera')
          : t('uiLibrary.gateControl.catalogDefaultTitle', 'Catalog default')
      }
    >
      {on ? t('uiLibrary.gateControl.on', 'on') : t('uiLibrary.gateControl.off', 'off')}
    </span>
  )
}
