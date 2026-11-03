/**
 * The `config` cardinality of the Customize catalog (D944): an extension whose
 * editor is a modal of its own. The catalog says WHICH capability is offered on
 * this device type; the registry below says which component edits it. A
 * catalog entry with no editor yet renders nothing (it never invents one).
 */
import { CAP_CUSTOMIZE_CATALOG, type DeviceInfo } from '@camstack/types'
import type { ComponentType, ReactNode } from 'react'
import { FanPresetsExtensionCard } from '../../../fan-presets/FanPresetsExtensionCard'
import { RemoteExtensionCard } from '../../../remote/RemoteExtensionCard'

export interface ConfigCardProps {
  readonly device: DeviceInfo
}

export interface ConfigCustomizeListProps extends ConfigCardProps {
  /** Render only this cap's editor (the Customize table opens one at a time). */
  readonly onlyCap?: string
}

const CONFIG_CARDS: Readonly<Record<string, ComponentType<ConfigCardProps>>> = {
  remote: RemoteExtensionCard,
  'fan-presets': FanPresetsExtensionCard,
}

/** The capabilities whose `config` target the catalog offers on this device type. */
export function configCardCaps(deviceType: string): readonly string[] {
  const caps: string[] = []
  for (const [cap, entry] of Object.entries(CAP_CUSTOMIZE_CATALOG)) {
    const offered = entry.targets.some(
      (target) =>
        target.cardinality === 'config' &&
        (target.deviceTypes as readonly string[]).includes(deviceType),
    )
    if (offered) caps.push(cap)
  }
  return caps
}

export function ConfigCustomizeList({ device, onlyCap }: ConfigCustomizeListProps): ReactNode {
  return configCardCaps(device.type).map((cap) => {
    if (onlyCap !== undefined && cap !== onlyCap) return null
    const Card = CONFIG_CARDS[cap]
    return Card === undefined ? null : <Card key={cap} device={device} />
  })
}
