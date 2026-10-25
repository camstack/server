/**
 * Pulse and span targets, in catalog order, for this device type.
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  type CustomizeCatalog,
  type CustomizeCatalogTarget,
  type DeviceInfo,
} from '@camstack/types'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type AssignmentFacts,
  assignmentAvailability,
  offerFromCatalog,
} from '../assignment-availability'
import type { CustomizationHandle } from '../use-customization'
import type { CameraSensorsRead } from '../use-camera-sensors-presence'
import { EventPulseCard } from './EventPulseCard'
import { EventSpanCard } from './EventSpanCard'
import { eventCardTargets } from './event-targets'

const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG

export interface EventCustomizeListProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly facts: AssignmentFacts
  readonly sensors: CameraSensorsRead
}

function targetOf(cap: string, id: string): CustomizeCatalogTarget | null {
  const entry = catalog[cap]
  if (entry === undefined) return null
  return entry.targets.find((target) => target.id === id) ?? null
}

export function EventCustomizeList({
  device,
  handle,
  facts,
  sensors,
}: EventCustomizeListProps): ReactNode {
  const { t } = useTranslation()
  return (
    <>
      {eventCardTargets().map((card) => {
        const view = card.pulse ?? card.span
        if (view === null) return null
        if (!view.deviceTypes.includes(device.type)) return null
        const target = targetOf(card.cap, view.id)
        if (target === null) return null
        const title = t(card.pulse !== null ? 'customize.doorbell.title' : 'customize.motion.title')
        const availability = assignmentAvailability(offerFromCatalog(card.cap, target), facts)
        if (card.pulse !== null) {
          return (
            <EventPulseCard
              key={card.cap}
              device={device}
              handle={handle}
              availability={availability}
              cap={card.cap}
              title={title}
              view={card.pulse}
            />
          )
        }
        if (card.span === null) return null
        return (
          <EventSpanCard
            key={card.cap}
            device={device}
            availability={availability}
            cap={card.cap}
            title={title}
            view={card.span}
            sensors={sensors}
          />
        )
      })}
    </>
  )
}
