/**
 * Create step for /build/compositions/new — type, role, name, room.
 */
import { COMPOSED_DEVICE_STABLE_ID_PREFIX, DeviceRole, DeviceType } from '@camstack/types'
import {
  Button,
  Select,
  useCoreBlocksCreateComposition,
  useDeviceManagerListPersistedByAddon,
  useDeviceManagerSetLocation,
  useDeviceManagerSetName,
} from '@camstack/ui-library'
import { deviceRoleMetaOf, deviceTypeMetaOf, useUiText } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { customizePath } from '../../lib/customization-routes'
import { buildSkeletonComposition } from './build-skeleton'

const FIELD_CLASS = 'px-1.5 py-0.5 text-[11px] bg-background border border-border rounded'

export function CompositionCreateForm(): ReactNode {
  const { t } = useTranslation()
  const uiText = useUiText()
  const navigate = useNavigate()
  const create = useCoreBlocksCreateComposition()
  const setName = useDeviceManagerSetName()
  const setLocation = useDeviceManagerSetLocation()
  const fleet = useDeviceManagerListPersistedByAddon({ addonId: 'composer' })
  const [type, setType] = useState(DeviceType.Sensor)
  const [role, setRole] = useState<DeviceRole | null>(DeviceRole.TemperatureSensor)
  const [name, setNameValue] = useState('')
  const [room, setRoom] = useState('')
  const [error, setError] = useState<string | null>(null)

  const composition = buildSkeletonComposition({ type, role })

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3 sm:p-4">
      <h2 className="text-sm font-semibold">{t('build.customDeviceTab.newComposedDevice')}</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[11px]">
          {t('compositionEditor.targetType')}
          <Select
            value={type}
            onChange={(e) => {
              const next = Object.values(DeviceType).find((v) => v === e.target.value)
              if (next !== undefined) setType(next)
            }}
            options={Object.values(DeviceType).map((v) => ({
              value: v,
              label: deviceTypeMetaOf(v, uiText).label,
            }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px]">
          {t('customize.identity.role')}
          <Select
            value={role ?? ''}
            onChange={(e) =>
              setRole(Object.values(DeviceRole).find((v) => v === e.target.value) ?? null)
            }
            options={[
              { value: '', label: t('customize.identity.noRole') },
              ...Object.values(DeviceRole).map((v) => ({
                value: v,
                label: deviceRoleMetaOf(v, uiText).label,
              })),
            ]}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px]">
          {t('compositionEditor.name')}
          <input
            className={FIELD_CLASS}
            value={name}
            onChange={(e) => setNameValue(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px]">
          {t('customize.identity.room')}
          <input className={FIELD_CLASS} value={room} onChange={(e) => setRoom(e.target.value)} />
        </label>
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <Button
        disabled={composition === null || create.isPending}
        onClick={() => {
          if (composition === null) return
          void (async () => {
            setError(null)
            try {
              const trimmed = name.trim()
              const { block } = await create.mutateAsync({
                block: {
                  ...(trimmed === '' ? {} : { name: trimmed }),
                  enabled: true,
                  composition,
                },
              })
              const stableId = `${COMPOSED_DEVICE_STABLE_ID_PREFIX}${block.id}`
              const refreshed = await fleet.refetch()
              const rows = refreshed.data ?? fleet.data
              const row = rows?.find((d) => d.stableId === stableId)
              if (row !== undefined) {
                if (trimmed !== '') await setName.mutateAsync({ deviceId: row.id, name: trimmed })
                if (room.trim() !== '') {
                  await setLocation.mutateAsync({ deviceId: row.id, location: room.trim() })
                }
                navigate(customizePath(row.id), { replace: true })
                return
              }
              navigate(`/build/compositions/${encodeURIComponent(block.id)}`, { replace: true })
            } catch (err: unknown) {
              setError(err instanceof Error ? err.message : String(err))
            }
          })()
        }}
      >
        {t('compositionEditor.save')}
      </Button>
    </section>
  )
}
