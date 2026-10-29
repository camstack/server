/**
 * A composed device is edited on the Customize tab via the shared card editor (D941).
 */
import {
  COMPOSED_DEVICE_STABLE_ID_PREFIX,
  coreBlockComposition,
  type DeviceInfo,
} from '@camstack/types'
import {
  Badge,
  ErrorBox,
  useCoreBlocksGetComposition,
  useCoreBlocksUpdateComposition,
} from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { skeletonFillStatus } from '../../composition-editor/build-skeleton'
import { ComposedDeviceEditDialog } from '../../composition-editor/ComposedDeviceEditDialog'
import { draftFromHelper, isHelperComposition } from '../../composition-editor/helper-form-model'
import { CompositionFieldsCardList } from './cards/CompositionFieldsCardList'
import { ConfigCustomizeList, configCardCaps } from './config/ConfigCustomizeList'
import { eventCardTargets } from './event/event-targets'
import { HelperSummaryCard } from './HelperSummaryCard'
import { IdentityRow } from './IdentityRow'
import { keyedArrayCardTargets } from './keyed/KeyedArrayCard'
import { scalarCardTargets } from './scalar/ScalarOverrideCard'

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
  const skipCaps = useMemo(() => {
    const s = new Set<string>()
    for (const { cap } of scalarCardTargets()) s.add(cap)
    for (const { cap } of keyedArrayCardTargets()) s.add(cap)
    for (const { cap } of eventCardTargets()) s.add(cap)
    for (const cap of configCardCaps(device.type)) s.add(cap)
    return s
  }, [device.type])

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

  if (isHelperComposition(composition)) {
    const helperDraft = draftFromHelper(composition.helper, device.name, device.location ?? '')
    if (helperDraft === null) {
      return <p role="alert">{t('helper.unreadable')}</p>
    }
    return (
      <div className="flex flex-col gap-3">
        <IdentityRow device={device} />
        <HelperSummaryCard draft={helperDraft} device={device} onEdit={() => setEditing(true)} />
        <ComposedDeviceEditDialog
          blockId={editing ? view.block.id : null}
          onClose={() => {
            setEditing(false)
            void read.refetch()
          }}
        />
      </div>
    )
  }

  const handle = {
    target: { addonId: device.addonId, stableId: device.stableId },
    state: { kind: 'present' as const, view, composition },
    saving: update.isPending,
    save: async (next: typeof composition | null) => {
      if (next === null)
        return {
          kind: 'refused' as const,
          reason: t('customize.composed.noDelete'),
        }
      try {
        await update.mutateAsync({
          blockId: view.block.id,
          expectedUpdatedAt: view.block.updatedAt,
          block: { composition: next },
        })
        await read.refetch()
        return { kind: 'saved' as const }
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err)
        return { kind: 'refused' as const, reason }
      }
    },
  }

  return (
    <div className="flex flex-col gap-3">
      <IdentityRow device={device} />
      {skeletonFillStatus(composition) === 'incomplete' && (
        <Badge variant="warning">{t('customize.blockStatus.incomplete')}</Badge>
      )}
      <ConfigCustomizeList device={device} />
      <CompositionFieldsCardList device={device} handle={handle} skipCaps={skipCaps} />
    </div>
  )
}
