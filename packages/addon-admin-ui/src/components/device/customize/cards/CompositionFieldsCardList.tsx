/**
 * Renders composition features decoded as generic fields cards (temperature, binary, …).
 */
import { compositionSourceKey, decodeCompositionToCards, type DeviceInfo } from '@camstack/types'
import { Boxes } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useDeviceLabel } from '@camstack/ui-library'
import { CustomizeCard } from '../CustomizeCard'
import { useCandidateDevices } from '../assignments/use-source-candidates'
import { currentComposition } from '../customization-read'
import type { CustomizationHandle } from '../use-customization'
import { vocabularyCapTitle } from '../vocabulary-field-label'
import { FieldsCardBody } from './FieldsCardBody'

export interface CompositionFieldsCardListProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  /** Caps already rendered by scalar/event/keyed cards — skip them here. */
  readonly skipCaps: ReadonlySet<string>
}

export function CompositionFieldsCardList({
  device,
  handle,
  skipCaps,
}: CompositionFieldsCardListProps): ReactNode {
  const { i18n } = useTranslation()
  const selfLabel = useDeviceLabel(device, 'compact')
  const current = currentComposition(handle.state)
  const devices = useCandidateDevices(current !== null)
  const names = useMemo(() => {
    if (devices.kind !== 'known') return new Map<string, string>()
    return new Map(
      devices.value.map((row) => [
        compositionSourceKey({ addonId: row.addonId, stableId: row.stableId }),
        row.name,
      ]),
    )
  }, [devices])
  if (current === null) return null
  const { model } = decodeCompositionToCards(current)
  const slots = model.cards.filter(
    (slot) => slot.card.cardKind === 'fields' && !skipCaps.has(slot.card.cap),
  )
  if (slots.length === 0) return null

  return (
    <>
      {slots.map((slot) => {
        if (slot.card.cardKind !== 'fields') return null
        const card = slot.card
        const capTitle = vocabularyCapTitle(card.cap, i18n.language)
        return (
          <CustomizeCard
            key={card.cap}
            id={card.cap}
            icon={Boxes}
            title={capTitle}
            testId={`fields-card-${card.cap}`}
          >
            <FieldsCardBody
              deviceId={device.id}
              selfName={selfLabel}
              card={card}
              handle={handle}
              names={names}
            />
          </CustomizeCard>
        )
      })}
    </>
  )
}
