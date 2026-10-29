/**
 * The `config` cardinality of the Customize catalog (D944): an extension whose
 * editor is a modal of its own. The catalog says WHICH capability is offered on
 * this device type; the registry below says which component edits it. A
 * catalog entry with no editor yet renders nothing (it never invents one).
 */
import { CAP_CUSTOMIZE_CATALOG, type DeviceInfo } from '@camstack/types'
import type { ComponentType, ReactNode } from 'react'
import { RemoteExtensionCard } from '../../../remote/RemoteExtensionCard'

export interface ConfigCardProps {
  readonly device: DeviceInfo
}

const CONFIG_CARDS: Readonly<Record<string, ComponentType<ConfigCardProps>>> = {
  remote: RemoteExtensionCard,
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

export function ConfigCustomizeList({ device }: ConfigCardProps): ReactNode {
  return configCardCaps(device.type).map((cap) => {
    const Card = CONFIG_CARDS[cap]
    return Card === undefined ? null : <Card key={cap} device={device} />
  })
}
