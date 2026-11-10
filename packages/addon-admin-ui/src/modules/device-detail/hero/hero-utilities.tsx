import type { HeroAction, HeroModel } from '@camstack/types'
import { Badge, Button, type HeroUtility } from '@camstack/ui-library'
import { History, Package, Power } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
  const gated = new Set(model.gated)
  const out: HeroUtility[] = []
  if (host.openHistory !== undefined) {
    out.push({
      id: 'history',
      icon: History,
      label: pickText(model.historyLabel, host.lang),
      tooltip: t('deviceHero.utility.history.tooltip', 'Opens the history of this device.'),
      onPress: host.openHistory,
    })
  }
  const consumables = model.consumables
  if (consumables !== null && consumables.items.length > 0) {
    out.push({
      id: 'consumables',
      icon: Package,
      label: t('deviceHero.utility.consumables.label', 'Consumables'),
      value:
        consumables.attention > 0
          ? t('deviceHero.utility.consumables.low', '{{count}} low', {
              count: consumables.attention,
            })
          : t('deviceHero.utility.consumables.ok', 'OK'),
      tone: consumables.attention > 0 ? 'warning' : 'default',
      tooltip: t(
        'deviceHero.utility.consumables.tooltip',
        'Shows the level of each consumable and which ones need attention.',
      ),
      panel: () => <ConsumablesPanel model={model} />,
    })
  }
  const supply = model.powerSupply
  if (supply !== null) {
    const readOnly = gated.has('power-supply')
    out.push({
      id: 'power-supply',
      icon: Power,
      label: t('deviceHero.utility.power.label', 'Power source'),
      ...(supply.on === null
        ? {}
        : {
            value:
              supply.on === true
                ? t('deviceHero.utility.power.on', 'On')
                : t('deviceHero.utility.power.off', 'Off'),
          }),
      tooltip: readOnly
        ? t(
            'deviceHero.utility.power.tooltipReadOnly',
            'Whether the power source feeding this device is on. Your session cannot change it.',
          )
        : t(
            'deviceHero.utility.power.tooltip',
            'Opens a menu to cut or restore the power feeding this device, or to restart it.',
          ),
      ...(readOnly
        ? { disabled: true }
        : { panel: (close: () => void) => <PowerPanel model={model} host={host} close={close} /> }),
    })
  }
  return out
}
