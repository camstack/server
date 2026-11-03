/**
 * The Device section of the creation dialog (D1004): pick a type, name it, and
 * where the type needs it pick the one source it is meaningless without. The
 * device is created naked; everything else attaches through Customize.
 */
import { DeviceType, type HelperMember } from '@camstack/types'
import {
  Button,
  deviceTypeMetaOf,
  Input,
  Select,
  useCoreBlocksCreateComposition,
  useDeviceManagerListPersistedByAddon,
  useDeviceManagerSetName,
  useUiText,
} from '@camstack/ui-library'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { customizePath } from '../../lib/customization-routes'
import { SourceSelector } from '../device/customize/source-selector/SourceSelector'
import { awaitDeviceIdForBlock } from './await-device-id'
import { canCreate, createNeedOf, nakedComposition, sourceRequestOf } from './device-create-model'

export interface DeviceCreateFormProps {
  readonly onTitle: (title: string) => void
}

export function DeviceCreateForm({ onTitle }: DeviceCreateFormProps): ReactNode {
  const { t } = useTranslation()
  const uiText = useUiText()
  const navigate = useNavigate()
  const create = useCoreBlocksCreateComposition()
  const setName = useDeviceManagerSetName()
  const fleet = useDeviceManagerListPersistedByAddon({ addonId: 'composer' })
  const [type, setType] = useState<DeviceType>(DeviceType.Sensor)
  const [name, setNameValue] = useState('')
  const [members, setMembers] = useState<readonly HelperMember[]>([])
  const [error, setError] = useState<string | null>(null)
  const source = members[0] ?? null
  const request = sourceRequestOf(type)
  const composition = nakedComposition(type, source)

  useEffect(() => {
    onTitle(t('helper.newDevice'))
  }, [onTitle, t])

  const save = async (): Promise<void> => {
    if (composition === null) return
    setError(null)
    try {
      const trimmed = name.trim()
      const { block } = await create.mutateAsync({
        block: { ...(trimmed === '' ? {} : { name: trimmed }), enabled: true, composition },
      })
      const id = await awaitDeviceIdForBlock(block.id, async () => {
        const refreshed = await fleet.refetch()
        return refreshed.data ?? fleet.data
      })
      if (id === null) {
        setError(t('helper.devicePending'))
        return
      }
      if (trimmed !== '') await setName.mutateAsync({ deviceId: id, name: trimmed })
      navigate(customizePath(id), { replace: true })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="device-create-form">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[11px]">
          {t('compositionEditor.targetType')}
          <Select
            value={type}
            onChange={(e) => {
              const next = Object.values(DeviceType).find((v) => v === e.target.value)
              if (next === undefined) return
              setType(next)
              setMembers([])
            }}
            options={Object.values(DeviceType).map((v) => ({
              value: v,
              label: deviceTypeMetaOf(v, uiText).label,
            }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px]">
          {t('compositionEditor.name')}
          <Input
            aria-label={t('compositionEditor.name')}
            value={name}
            onChange={(e) => setNameValue(e.target.value)}
          />
        </label>
      </div>
      {request !== null && (
        <div className="flex flex-col gap-1" data-testid="device-create-source">
          <p className="text-[11px] text-foreground-muted">
            {t(`helper.deviceSource.${createNeedOf(type)}`)}
          </p>
          <SourceSelector
            kind="members"
            request={request}
            enabled
            members={members}
            onMembersChange={setMembers}
            onRefuse={() => undefined}
          />
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <Button disabled={!canCreate(type, source) || create.isPending} onClick={() => void save()}>
        {t('compositionEditor.save')}
      </Button>
    </div>
  )
}
