import type { ReactElement } from 'react'
import {
  useDeviceManagerGetBindings,
  useDeviceManagerGetDevice,
} from '../../../generated/system-hooks'
import {
  ConnectedAutomationCard,
  ConnectedButtonCard,
  ConnectedScriptCard,
} from './ConnectedActionCards'
import { ConnectedAlarmCard } from './ConnectedAlarmCard'
import { ConnectedApplianceCard } from './ConnectedApplianceCard'
import { ConnectedClimateCard } from './ConnectedClimateCard'
import { ConnectedControlCard } from './ConnectedControlCard'
import { ConnectedCoverCard } from './ConnectedCoverCard'
import { ConnectedDishwasherCard } from './ConnectedDishwasherCard'
import { ConnectedEventCard } from './ConnectedEventCard'
import { ConnectedFanCard } from './ConnectedFanCard'
import { ConnectedGatewayCard } from './ConnectedGatewayCard'
import { ConnectedWorkloadCard } from './ConnectedWorkloadCard'
import { ConnectedHeaterCard } from './ConnectedHeaterCard'
import { ConnectedEnergyCard } from './ConnectedEnergyCard'
import { ConnectedHeatPumpCard } from './ConnectedHeatPumpCard'
import { ConnectedIrTransmitterCard } from './ConnectedIrTransmitterCard'
import { ConnectedHumidifierCard } from './ConnectedHumidifierCard'
import { ConnectedImageCard } from './ConnectedImageCard'
import { ConnectedLightCard } from './ConnectedLightCard'
import { ConnectedLockCard } from './ConnectedLockCard'
import { ConnectedMediaCard } from './ConnectedMediaCard'
import { ConnectedNotifierCard } from './ConnectedNotifierCard'
import { ConnectedPetFeederCard } from './ConnectedPetFeederCard'
import { ConnectedPetFountainCard } from './ConnectedPetFountainCard'
import { type ConnectedCardProps, ConnectedPlugCard } from './ConnectedPlugCard'
import { ConnectedMowerCard, ConnectedVacuumCard } from './ConnectedRobotCard'
import { ConnectedSirenCard } from './ConnectedSirenCard'
import { ConnectedUpdateCard } from './ConnectedUpdateCard'
import { ConnectedValveCard } from './ConnectedValveCard'
import { ConnectedWaterHeaterCard } from './ConnectedWaterHeaterCard'
import { ConnectedWeatherCard } from './ConnectedWeatherCard'
import { ConnectedWeatherStationCard } from './ConnectedWeatherStationCard'
import {
  type ConnectedCardKind,
  type ConnectedCardResolution,
  connectedCardKindOf,
} from './connected-card-kind'
import { ConnectedContainerCard } from './ConnectedContainerCard'

/** Resolves the card of a device; a failed read answers `null` so the caller falls back. */
export function useConnectedCardKind(deviceId: number): ConnectedCardResolution {
  const device = useDeviceManagerGetDevice({ deviceId })
  const bindings = useDeviceManagerGetBindings({ deviceId })
  if (device.status === 'pending' || bindings.status === 'pending') return 'pending'
  if (device.status === 'error' || bindings.status === 'error') return null
  return connectedCardKindOf(
    device.data?.type ?? null,
    device.data?.role ?? null,
    bindings.data.entries.map((entry) => entry.capName),
  )
}

export type { ConnectedCardKind, ConnectedCardResolution } from './connected-card-kind'
export { connectedCardKindOf } from './connected-card-kind'

export interface ConnectedDeviceCardProps extends ConnectedCardProps {
  readonly kind: ConnectedCardKind
}

/** The card of a real device, by scene. */
export function ConnectedDeviceCard({
  kind,
  ...props
}: ConnectedDeviceCardProps): ReactElement | null {
  switch (kind) {
    case 'plug':
      return <ConnectedPlugCard {...props} />
    case 'climate':
      return <ConnectedClimateCard {...props} />
    case 'cover':
      return <ConnectedCoverCard {...props} />
    case 'light':
      return <ConnectedLightCard {...props} />
    case 'fan':
      return <ConnectedFanCard {...props} />
    case 'heater':
      return <ConnectedHeaterCard {...props} />
    case 'appliance':
      return <ConnectedApplianceCard {...props} />
    case 'dishwasher':
      return <ConnectedDishwasherCard {...props} />
    case 'media':
      return <ConnectedMediaCard {...props} />
    case 'vacuum':
      return <ConnectedVacuumCard {...props} />
    case 'mower':
      return <ConnectedMowerCard {...props} />
    case 'heat-pump':
      return <ConnectedHeatPumpCard {...props} />
    case 'energy':
      return <ConnectedEnergyCard {...props} />
    case 'water-heater':
      return <ConnectedWaterHeaterCard {...props} />
    case 'ir-transmitter':
      return <ConnectedIrTransmitterCard {...props} />
    case 'lock':
      return <ConnectedLockCard {...props} />
    case 'alarm':
      return <ConnectedAlarmCard {...props} />
    case 'humidifier':
      return <ConnectedHumidifierCard {...props} />
    case 'valve':
      return <ConnectedValveCard {...props} />
    case 'siren':
      return <ConnectedSirenCard {...props} />
    case 'pet-feeder':
      return <ConnectedPetFeederCard {...props} />
    case 'pet-fountain':
      return <ConnectedPetFountainCard {...props} />
    case 'weather':
      return <ConnectedWeatherCard {...props} />
    case 'weather-station':
      return <ConnectedWeatherStationCard {...props} />
    case 'button':
      return <ConnectedButtonCard {...props} />
    case 'update':
      return <ConnectedUpdateCard {...props} />
    case 'script':
      return <ConnectedScriptCard {...props} />
    case 'automation':
      return <ConnectedAutomationCard {...props} />
    case 'control':
      return <ConnectedControlCard {...props} />
    case 'event':
      return <ConnectedEventCard {...props} />
    case 'image':
      return <ConnectedImageCard {...props} />
    case 'notifier':
      return <ConnectedNotifierCard {...props} />
    case 'gateway':
      return <ConnectedGatewayCard {...props} />
    case 'container':
      return <ConnectedContainerCard {...props} />
    case 'workload':
      return <ConnectedWorkloadCard {...props} />
  }
}
