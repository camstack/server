import type { HeroAction, HeroModel } from '@camstack/types'
import { History, Package, Power } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from '../../primitives/badge'
import { Button } from '../../primitives/button'
import type { HeroUtility } from '../hero-scene'
import type { HeroCardHost } from './HeroModelCard'
import { pickText } from './hero-model-view'

function ConsumablesPanel({ model }: { readonly model: HeroModel }): ReactNode {
  const items = model.consumables?.items ?? []
  return (
    <ul data-testid="hero-consumables-panel" className="flex min-w-52 flex-col gap-1.5 p-3">
      {items.map((item) => (
        <li key={item.key} className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0 truncate text-foreground">{item.label}</span>
          <Badge variant={item.needsAttention ? 'warning' : 'neutral'} size="sm">
            {item.level === null ? '–' : `${String(Math.round(item.level))}%`}
          </Badge>
        </li>
      ))}
    </ul>
  )
}

function PowerPanel({
  model,
  host,
  close,
}: {
  readonly model: HeroModel
  readonly host: HeroCardHost
  readonly close: () => void
}): ReactNode {
  const supply = model.powerSupply
  if (supply === null) return null
  const toggle: HeroAction = supply.on === true ? supply.powerOff : supply.powerOn
  const entry = (action: HeroAction, disabled: boolean): ReactNode => (
    <Button
      size="sm"
      variant="outline"
      className="w-full justify-start"
      disabled={host.busy || disabled}
      data-testid={`hero-utility-action-${action.id}`}
      onClick={() => {
        close()
        host.run(action.call, action)
      }}
    >
      {pickText(action.label, host.lang)}
    </Button>
  )
  return (
    <div className="flex min-w-48 flex-col gap-1.5 p-2">
      {entry(toggle, false)}
      {entry(supply.restart, supply.on !== true)}
    </div>
  )
}

/**
 * The utilities a hero model offers, in a fixed order: history (when the page has
 * one to open), consumables, power source. One entry per slot the model carries;
 * a device without the slot gets no button. The remote keeps its own foot button.
 */
export function useHeroUtilities(model: HeroModel, host: HeroCardHost): readonly HeroUtility[] {
  const labels = host.labels
  const gated = new Set(model.gated)
  const out: HeroUtility[] = []
  if (host.openHistory !== undefined) {
    out.push({
      id: 'history',
      icon: History,
      label: pickText(model.historyLabel, host.lang),
      tooltip: labels.historyTooltip,
      onPress: host.openHistory,
    })
  }
  const consumables = model.consumables
  if (consumables !== null && consumables.items.length > 0) {
    out.push({
      id: 'consumables',
      icon: Package,
      label: labels.consumables.label,
      value:
        consumables.attention > 0
          ? labels.consumables.low(consumables.attention)
          : labels.consumables.ok,
      tone: consumables.attention > 0 ? 'warning' : 'default',
      tooltip: labels.consumables.tooltip,
      panel: () => <ConsumablesPanel model={model} />,
    })
  }
  const supply = model.powerSupply
  if (supply !== null) {
    const readOnly = gated.has('power-supply')
    out.push({
      id: 'power-supply',
      icon: Power,
      label: labels.power.label,
      ...(supply.on === null
        ? {}
        : { value: supply.on === true ? labels.power.on : labels.power.off }),
      tooltip: readOnly ? labels.power.tooltipReadOnly : labels.power.tooltip,
      ...(readOnly
        ? { disabled: true }
        : { panel: (close: () => void) => <PowerPanel model={model} host={host} close={close} /> }),
    })
  }
  return out
}
