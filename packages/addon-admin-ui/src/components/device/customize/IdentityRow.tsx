/**
 * Identity (spec U9): name, room, hidden and role in one row. Every control
 * writes an authority that already exists — no new store: name → `setName`
 * (EditableNameRow, stamps `userNamed`), room → `setLocation`, visibility →
 * the ONE display override `DisplaySection` also writes, role → `setRole`.
 * Role is shown, not edited, on a spawned accessory child: its provider
 * re-applies it on every spawn (`roleIsProviderOwned`). Type is not shown —
 * it is not the operator's to change.
 */
import type { DeviceInfo } from '@camstack/types'
import {
  Checkbox,
  deviceRoleMetaOf,
  SECTION_BODY,
  SECTION_CARD,
  Select,
  useDeviceManagerSetDisplay,
  useDeviceManagerSetRole,
  useUiText,
} from '@camstack/ui-library'
import type { UiTextFn } from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EditableNameRow } from '../overview-adapters/shared/EditableNameRow'
import { LocationRow } from '../overview-adapters/shared/LocationRow'
import { InfoRow } from '../overview-adapters/shared/overview-primitives'
import { displayWithHidden, isKnownRole, roleIsProviderOwned, roleOptions } from './identity-model'

export interface IdentityRowProps {
  readonly device: DeviceInfo
}

export function IdentityRow({ device }: IdentityRowProps): ReactNode {
  const { t } = useTranslation()
  const uiText = useUiText()
  const queryClient = useQueryClient()
  // Every deviceManager read: lists (`listAll`) and the Overview
  // (`getDeviceAggregate`) show role and visibility too — as DisplaySection.
  // A refused write is said by name (D391), and a later success clears it.
  const [refusal, setRefusal] = useState<string | null>(null)
  const clearRefusal = (): void => setRefusal(null)
  const refresh = {
    onSuccess: () => {
      clearRefusal()
      void queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
    },
    onError: (error: { readonly message: string }) => setRefusal(error.message),
  }
  const setRole = useDeviceManagerSetRole()
  const setDisplay = useDeviceManagerSetDisplay()
  const hidden = device.display?.hidden === true

  return (
    <section
      aria-label={t('customize.identity.title')}
      className={`${SECTION_CARD} ${SECTION_BODY}`}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <EditableNameRow
          deviceId={device.id}
          initialName={device.name}
          label={t('customize.identity.name')}
          layout="stacked"
          onError={setRefusal}
          onSaved={clearRefusal}
          onCancel={clearRefusal}
        />
        <LocationRow
          deviceId={device.id}
          initialLocation={device.location}
          label={t('customize.identity.room')}
          layout="stacked"
          onError={setRefusal}
          onSaved={clearRefusal}
          onCancel={clearRefusal}
        />
        <InfoRow
          label={t('customize.identity.hidden')}
          layout="stacked"
          value={
            <Checkbox
              aria-label={t('deviceDisplay.hideFromLists')}
              checked={hidden}
              disabled={setDisplay.isPending}
              onChange={(e) =>
                setDisplay.mutate(
                  {
                    deviceId: device.id,
                    display: displayWithHidden(device.display, e.target.checked),
                  },
                  refresh,
                )
              }
            />
          }
        />
        <InfoRow
          label={t('customize.identity.role')}
          layout="stacked"
          value={
            roleIsProviderOwned(device) ? (
              <span>{roleLabel(device.role, t('customize.identity.noRole'), uiText)}</span>
            ) : (
              <Select
                aria-label={t('customize.identity.role')}
                value={device.role ?? ''}
                disabled={setRole.isPending}
                options={[
                  { value: '', label: t('customize.identity.noRole') },
                  ...roleOptions(device.role, device.type).map((role) => ({
                    value: role,
                    label: roleLabel(role, t('customize.identity.noRole'), uiText),
                  })),
                ]}
                onChange={(e) =>
                  setRole.mutate(
                    {
                      deviceId: device.id,
                      role: e.target.value === '' ? null : e.target.value,
                    },
                    refresh,
                  )
                }
              />
            )
          }
        />
      </div>
      {refusal !== null && (
        <p role="alert" className="mt-2 text-xs text-danger break-words">
          {refusal}
        </p>
      )}
    </section>
  )
}

/** A known role by its label; any other stored string as itself; none as `noRole`. */
function roleLabel(role: string | null | undefined, noRole: string, uiText: UiTextFn): string {
  if (role === null || role === undefined || role === '') return noRole
  return isKnownRole(role) ? deviceRoleMetaOf(role, uiText).label : role
}
