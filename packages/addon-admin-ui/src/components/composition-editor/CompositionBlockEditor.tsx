/**
 * Shared card editor for a stored composition block (/build/compositions/:id).
 */
import { coreBlockComposition, DeviceType } from '@camstack/types'
import {
  Badge,
  ErrorBox,
  useCoreBlocksGetComposition,
  useCoreBlocksUpdateComposition,
  useDeviceManagerSetLocation,
} from '@camstack/ui-library'
import { type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CompositionFieldsCardList } from '../device/customize/cards/CompositionFieldsCardList'
import { eventCardTargets } from '../device/customize/event/event-targets'
import { keyedArrayCardTargets } from '../device/customize/keyed/KeyedArrayCard'
import { scalarCardTargets } from '../device/customize/scalar/ScalarOverrideCard'
import { skeletonFillStatus } from './build-skeleton'
import { HelperWizard } from './HelperWizard'
import { draftFromHelper, isHelperComposition, writeHelper } from './helper-form-model'

export interface CompositionBlockEditorProps {
  readonly blockId: string
}

export function CompositionBlockEditor({ blockId }: CompositionBlockEditorProps): ReactNode {
  const { t } = useTranslation()
  const read = useCoreBlocksGetComposition({ blockId })
  const update = useCoreBlocksUpdateComposition()
  const setLocation = useDeviceManagerSetLocation()
  const skipCaps = useMemo(() => {
    const s = new Set<string>()
    for (const { cap } of scalarCardTargets()) s.add(cap)
    for (const { cap } of keyedArrayCardTargets()) s.add(cap)
    for (const { cap } of eventCardTargets()) s.add(cap)
    return s
  }, [])

  if (read.status === 'pending') {
    return <p role="status">{t('compositionEditor.loading')}</p>
  }
  if (read.status === 'error') {
    return <ErrorBox title={t('compositionEditor.loadFailed')} message={read.error.message} />
  }
  if (read.data.state === 'not-loaded') {
    return <p role="status">{t('customize.status.notLoaded', { reason: read.data.reason })}</p>
  }
  const view = read.data.view
  if (view === null) return <p>{t('compositionEditor.notFound', { blockId })}</p>
  const composition = coreBlockComposition(view.block)
  if (composition === null) return <p>{t('compositionEditor.notComposition')}</p>

  if (isHelperComposition(composition)) {
    const helperDraft = draftFromHelper(composition.helper, view.block.name, '')
    if (helperDraft === null) {
      return <p role="alert">{t('helper.unreadable')}</p>
    }
    const deviceId = view.state.kind === 'answered' ? (view.state.state?.deviceId ?? null) : null
    return (
      <HelperWizard
        purpose="edit"
        initial={helperDraft}
        start="parameters"
        saving={update.isPending}
        onSave={async (draft) => {
          const lines = await writeHelper(draft, async (next, name) => {
            await update.mutateAsync({
              blockId: view.block.id,
              expectedUpdatedAt: view.block.updatedAt,
              block: {
                composition: next,
                ...(name === '' ? {} : { name }),
              },
            })
            if (deviceId !== null && draft.room.trim() !== '') {
              await setLocation.mutateAsync({ deviceId, location: draft.room.trim() })
            }
            await read.refetch()
          })
          if (lines.length > 0) return { kind: 'refused', lines }
          return { kind: 'saved', deviceId: deviceId ?? 0 }
        }}
      />
    )
  }

  const fill = skeletonFillStatus(composition)
  const deviceStub = {
    id: 0,
    name: view.block.name,
    addonId: 'composer',
    stableId: `composed-${blockId}`,
    type: composition.target.kind === 'new' ? composition.target.type : DeviceType.Sensor,
    location: '',
    disabled: false,
    parentDeviceId: null,
    role: composition.target.kind === 'new' ? composition.target.role : null,
    online: true,
    probed: true,
    features: [],
    isCamera: false,
    config: {},
    secretConfigPaths: [],
    metadata: {},
  }

  const handle = {
    target: { addonId: 'composer', stableId: deviceStub.stableId },
    state: { kind: 'present' as const, view, composition },
    saving: update.isPending,
    save: async (next: typeof composition | null) => {
      if (next === null) return { kind: 'refused' as const, reason: 'cannot delete here' }
      try {
        await update.mutateAsync({
          blockId: view.block.id,
          expectedUpdatedAt: view.block.updatedAt,
          block: { composition: next },
        })
        await read.refetch()
        return { kind: 'saved' as const }
      } catch (err: unknown) {
        return {
          kind: 'refused' as const,
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    },
  }

  return (
    <div className="flex flex-col gap-2">
      <Badge variant={fill === 'incomplete' ? 'warning' : 'success'}>
        {t(`customize.blockStatus.${fill === 'incomplete' ? 'incomplete' : view.block.status}`)}
      </Badge>
      <CompositionFieldsCardList device={deviceStub} handle={handle} skipCaps={skipCaps} />
    </div>
  )
}
