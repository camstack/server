/**
 * A composed device is edited on the Customize tab via the shared card editor (D941).
 */
import {
  COMPOSED_DEVICE_STABLE_ID_PREFIX,
  coreBlockComposition,
  type DeviceInfo,
  DeviceType,
} from '@camstack/types'
import {
  Badge,
  ErrorBox,
  useCoreBlocksGetComposition,
  useCoreBlocksUpdateComposition,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { skeletonFillStatus } from '../../composition-editor/build-skeleton'
import { ComposedDeviceEditDialog } from '../../composition-editor/ComposedDeviceEditDialog'
import { draftFromHelper, isHelperComposition } from '../../composition-editor/helper-form-model'
import { LinkedDevicesTable } from './kinds/LinkedDevicesTable'
import { CustomizeTable } from './table/CustomizeTable'
import { HelperSummaryCard } from './HelperSummaryCard'
import { IdentityRow } from './IdentityRow'
import { useCameraSensors } from './use-camera-sensors-presence'
import { useCustomizeFacts } from './use-customize-facts'
import { useDefaultConsumables } from './use-default-consumables'
import type { AssignmentFacts } from './assignment-availability'

export interface ComposedCustomizeBodyProps {
  readonly device: DeviceInfo
}

export function ComposedCustomizeBody({ device }: ComposedCustomizeBodyProps): ReactNode {
  const { t } = useTranslation()
  const blockId = device.stableId.startsWith(COMPOSED_DEVICE_STABLE_ID_PREFIX)
    ? device.stableId.slice(COMPOSED_DEVICE_STABLE_ID_PREFIX.length)
    : null
  const read = useCoreBlocksGetComposition(
    { blockId: blockId ?? '' },
    { enabled: blockId !== null },
  )
  const update = useCoreBlocksUpdateComposition()
  const [editing, setEditing] = useState(false)
  // Hooks run before any early return: the facts are read for the device whatever the block says.
  const facts = useCustomizeFacts(device, null)
  const cameraSensors = useCameraSensors(device.id, false)
  const defaultConsumables = useDefaultConsumables(device.id, facts.nativeCaps, facts.wireable)

  if (blockId === null) {
    return <p className="text-xs text-foreground-subtle">{t('customize.composed.missingBlock')}</p>
  }
  if (read.status === 'pending') {
    return (
      <p role="status" className="text-xs text-foreground-subtle">
        {t('customize.loadingDevice')}
      </p>
    )
  }
  if (read.status === 'error') {
    return (
      <ErrorBox
        title={t('customize.composed.loadFailed')}
        message={read.error.message}
        onRetry={() => void read.refetch()}
      />
    )
  }
  if (read.data.state === 'not-loaded') {
    return (
      <p role="status" className="text-xs text-foreground-subtle">
        {t('customize.status.notLoaded', { reason: read.data.reason })}
      </p>
    )
  }
  const view = read.data.view
  if (view === null) {
    return <p className="text-xs text-foreground-subtle">{t('customize.composed.notFound')}</p>
  }
  const composition = coreBlockComposition(view.block)
  if (composition === null) {
    return <p className="text-xs text-foreground-subtle">{t('compositionEditor.notComposition')}</p>
  }

  const handle = {
    target: { addonId: device.addonId, stableId: device.stableId },
    state: { kind: 'present' as const, view, composition },
    saving: update.isPending,
    save: async (next: typeof composition | null) => {
      // A built device exists without facets: removing the last one leaves it naked, it never
      // deletes the block (D1004).
      const stored = next ?? { ...composition, features: [] }
      try {
        await update.mutateAsync({
          blockId: view.block.id,
          expectedUpdatedAt: view.block.updatedAt,
          block: { composition: stored },
        })
        await read.refetch()
        return { kind: 'saved' as const }
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err)
        return { kind: 'refused' as const, reason }
      }
    },
  }

  const assignmentFacts: AssignmentFacts = {
    deviceType: device.type,
    composable: facts.composable,
    nativeCaps: facts.nativeCaps,
    cameraSensors: 'absent',
  }
  // A helper keeps its read-only summary and its Edit dialog, and ALSO gets the lists any
  // composed device gets (D1004): the helper never hides Customize.
  const helperDraft = isHelperComposition(composition)
    ? draftFromHelper(composition.helper, device.name, device.location ?? '')
    : null
  return (
    <div className="flex flex-col gap-3">
      <IdentityRow device={device} />
      {isHelperComposition(composition) && helperDraft === null && (
        <p role="alert">{t('helper.unreadable')}</p>
      )}
      {helperDraft !== null && (
        <>
          <HelperSummaryCard draft={helperDraft} device={device} onEdit={() => setEditing(true)} />
          <ComposedDeviceEditDialog
            blockId={editing ? view.block.id : null}
            onClose={() => {
              setEditing(false)
              void read.refetch()
            }}
          />
        </>
      )}
      {skeletonFillStatus(composition) === 'incomplete' && (
        <Badge variant="warning">{t('customize.blockStatus.incomplete')}</Badge>
      )}
      <CustomizeTable
        device={device}
        handle={handle}
        facts={assignmentFacts}
        sensors={cameraSensors}
        defaults={defaultConsumables}
      />
      {device.type === DeviceType.Camera && <LinkedDevicesTable device={device} />}
    </div>
  )
}
