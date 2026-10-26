/**
 * The display override (icon, label, unit, precision) inside Customize's
 * identity block. Hidden lives beside role. Nothing here writes: the page's
 * one Save does, through the identity draft.
 */
import type { DeviceInfo } from '@camstack/types'
import { DeviceType, baseUnitOf, unitDimension } from '@camstack/types'
import {
  Button,
  ROLE_DESCRIPTOR,
  deviceRoleMetaOf,
  deviceTypeMetaOf,
  resolveDisplayIcon,
  useIconGlyphsVersion,
  useDeviceManagerGetRoleDisplayDefaults,
  useDeviceManagerSetRoleDisplayDefaults,
  useUiText,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { PrecisionInput } from '../../shared/PrecisionInput'
import { UnitPicker } from '../../shared/UnitPicker'
import type { DisplayForm } from '../identity-draft'
import { InfoRow } from '../overview-adapters/shared/overview-primitives'
import { DisplayIconPicker } from '../tabs/DisplayIconPicker'

const FIELD_CLASS =
  'w-full min-w-0 px-1.5 py-0.5 text-[11px] bg-background border border-border rounded focus:outline-none focus:border-primary disabled:opacity-50'

export interface IdentityDisplayFieldsProps {
  readonly device: DeviceInfo
  readonly role: string | null
  readonly display: DisplayForm
  readonly onChange: (patch: Partial<DisplayForm>) => void
}

function parsePrecision(raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function IdentityDisplayFields({
  device,
  role,
  display,
  onChange,
}: IdentityDisplayFieldsProps): ReactNode {
  const uiText = useUiText()
  useIconGlyphsVersion()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const descriptor = role !== null ? ROLE_DESCRIPTOR[role] : undefined
  const isNumericRole = descriptor?.kind === 'numeric'
  const labelIsDrawn =
    role !== null || (device.parentDeviceId !== null && device.parentDeviceId !== undefined)
  const chosen = device.sourceInfo?.quantity
  const quantity =
    descriptor?.kind === 'numeric'
      ? (descriptor.quantity ?? (chosen !== undefined && chosen !== 'device' ? chosen : undefined))
      : undefined
  const sourceUnit = quantity !== undefined ? baseUnitOf(quantity) : undefined
  const dimension = sourceUnit !== undefined ? unitDimension(sourceUnit) : undefined

  const { data: roleDefaultsData } = useDeviceManagerGetRoleDisplayDefaults(
    {},
    { staleTime: 60_000, enabled: role !== null },
  )
  const setRoleDefaults = useDeviceManagerSetRoleDisplayDefaults({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
  })

  const onSetRoleDefault = (): void => {
    if (role === null) return
    const precision = parsePrecision(display.precision)
    const roleLevel = {
      ...(display.icon !== '' ? { icon: display.icon } : {}),
      ...(display.unit !== '' ? { unit: display.unit } : {}),
      ...(precision !== undefined ? { precision } : {}),
    }
    setRoleDefaults.mutate({
      defaults: { ...roleDefaultsData?.defaults, [role]: roleLevel },
    })
  }

  const roleDefaultIconKey = role !== null ? roleDefaultsData?.defaults?.[role]?.icon : undefined
  const roleDefaultIcon =
    roleDefaultIconKey !== undefined ? resolveDisplayIcon(roleDefaultIconKey) : undefined
  const builtIn =
    role !== null ? deviceRoleMetaOf(role, uiText) : deviceTypeMetaOf(device.type, uiText)
  const inherited = {
    icon: roleDefaultIcon ?? builtIn.icon,
    label: roleDefaultIcon !== undefined ? String(roleDefaultIconKey) : builtIn.label,
  }
  const inheritedLabel =
    role === null && device.type === DeviceType.Container
      ? t('deviceDisplay.inheritedContainer')
      : roleDefaultIcon !== undefined
        ? t('deviceDisplay.inheritedRoleDefault', { icon: inherited.label, role: builtIn.label })
        : t('deviceDisplay.inherited', { name: inherited.label })
  const roleLabel = role !== null ? deviceRoleMetaOf(role, uiText).label : ''

  return (
    <div className="mt-3 divide-y divide-border border-t border-border">
      <InfoRow
        label={t('deviceDisplay.icon')}
        value={
          <DisplayIconPicker
            deviceName={device.name}
            value={display.icon}
            inheritedIcon={inherited.icon}
            inheritedLabel={inheritedLabel}
            disabled={false}
            onChange={(icon) => onChange({ icon })}
          />
        }
      />
      {labelIsDrawn && (
        <InfoRow
          label={t('deviceDisplay.label')}
          value={
            <input
              type="text"
              className={FIELD_CLASS}
              aria-label={t('deviceDisplay.label')}
              placeholder={role !== null ? roleLabel : device.name}
              value={display.label}
              onChange={(e) => onChange({ label: e.target.value })}
            />
          }
        />
      )}
      {isNumericRole && (
        <>
          <InfoRow
            label={t('deviceDisplay.unit')}
            value={
              <UnitPicker
                dimension={dimension}
                value={display.unit}
                onChange={(unit) => onChange({ unit })}
                disabled={false}
                aria-label={t('deviceDisplay.unit')}
                inheritLabel={t('deviceDisplay.unitSource', {
                  unit: sourceUnit !== undefined ? ` (${sourceUnit})` : '',
                })}
                emptyReason={t('deviceDisplay.unitSource', { unit: '' })}
              />
            }
          />
          <InfoRow
            label={t('deviceDisplay.precision')}
            value={
              <PrecisionInput
                aria-label={t('deviceDisplay.precision')}
                placeholder={t('deviceDisplay.precisionInherit')}
                value={display.precision}
                onChange={(precision) => onChange({ precision })}
                disabled={false}
              />
            }
          />
        </>
      )}
      {role !== null && (
        <div className="px-3 sm:px-4 py-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSetRoleDefault}
            disabled={setRoleDefaults.isPending}
            title={t('deviceDisplay.setRoleDefaultTitle', { role: roleLabel })}
          >
            {t('deviceDisplay.setRoleDefault', { role: roleLabel })}
          </Button>
        </div>
      )}
    </div>
  )
}
