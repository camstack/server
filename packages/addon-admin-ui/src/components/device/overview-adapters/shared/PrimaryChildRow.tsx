/**
 * PrimaryChildRow — selects which entity-child of a CONTAINER device is its
 * PRIMARY child, rendered as a row in the Device Info / Identity block next to
 * Name + Location.
 *
 * A CONTAINER device renders AS its primary child (same hero + same row control).
 * The primary child is resolved by priority default, or by the operator's
 * persisted override. This row lets the operator change that override; the pick
 * is persisted DURABLY on the container's `primaryChildEntityId` via
 * `deviceManager.setPrimaryChildEntityId`, keyed on the chosen child's
 * re-sync/rename-stable `entityId` (so it survives a re-sync that reallocates the
 * child's numeric id). A legacy numeric `linkDeviceId` is still honored as a
 * fallback for picks made before the durable field existed.
 *
 * Previously this selector floated on the container hero card; it now lives in
 * the primary config block. The component self-gates: it renders nothing unless
 * the device is a container with MORE THAN ONE eligible child (so non-containers
 * and single-child containers never show an empty selector). The host adapter can
 * therefore mount it unconditionally.
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  PrimaryChildPicker,
  childListName,
  resolveContainerPrimary,
  useDeviceManagerSetPrimaryChildEntityId,
  type ContainerChild,
  type PrimaryChildOption,
} from '@camstack/ui-library'
import { DeviceType } from '@camstack/types'
import { useDevice, useDeviceChildren } from '../../../../hooks/useDevice'
import { InfoRow } from './overview-primitives'
import { useTranslation } from 'react-i18next'

export function PrimaryChildRow({ deviceId }: { readonly deviceId: number }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: device } = useDevice(deviceId)
  const { data: childrenData } = useDeviceChildren(deviceId)
  const [error, setError] = useState<string | null>(null)

  const setPrimary = useDeviceManagerSetPrimaryChildEntityId({
    onSuccess: () => {
      setError(null)
      // Re-fetch the container so the new primaryChildEntityId drives the
      // hero/row/picker selection.
      void queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
    onError: (mutationError) => {
      setError(`Could not change primary child: ${mutationError.message}`)
    },
  })

  // Gate 1: only containers participate. A non-container never has a
  // primary-child override.
  if (device === undefined || device === null) return null
  const deviceType = String((device as { type?: unknown }).type ?? '')
  if (deviceType !== DeviceType.Container) return null

  // Inside the container's own list a child drops the container's name (D356
  // names children after it); the full name stays on every other surface.
  const parentName = String((device as { name?: unknown }).name ?? '')
  const options: readonly PrimaryChildOption[] = (childrenData ?? []).map((c) => ({
    id: c.id,
    stableId: c.stableId,
    type: c.type,
    name: childListName(c, parentName),
    ...(c.sourceInfo ? { sourceInfo: { id: c.sourceInfo.id } } : {}),
  }))

  // Gate 2: a single eligible child has no choice to make — hide the row so the
  // operator never sees a one-option selector.
  if (options.length <= 1) return null

  const linkDeviceId =
    typeof (device as { linkDeviceId?: unknown }).linkDeviceId === 'number'
      ? (device as { linkDeviceId: number }).linkDeviceId
      : null
  const primaryChildEntityId =
    typeof (device as { primaryChildEntityId?: unknown }).primaryChildEntityId === 'string'
      ? (device as { primaryChildEntityId: string }).primaryChildEntityId
      : null

  const refs: readonly ContainerChild[] = options
  const primary = resolveContainerPrimary(refs, linkDeviceId, primaryChildEntityId)
  // resolveContainerPrimary returns null only for an empty child set; we've
  // already gated on options.length > 1, so primary is always a live child here.
  const selectedId = primary === null ? options[0].id : primary.id

  return (
    <>
      <InfoRow
        label={t('shared.primaryChildRow.primaryChild', 'Primary child')}
        value={
          <PrimaryChildPicker
            childrenList={options}
            selectedId={selectedId}
            onSetPrimary={(childEntityId) =>
              setPrimary.mutate({ deviceId, primaryChildEntityId: childEntityId })
            }
            disabled={setPrimary.isPending}
          />
        }
      />
      {error !== null && (
        <p role="alert" className="px-3 sm:px-4 py-1.5 text-[11px] text-danger">
          {error}
        </p>
      )}
    </>
  )
}
