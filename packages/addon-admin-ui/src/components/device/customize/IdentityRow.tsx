/**
 * Identity (name, room, type, role, hidden, icon and the rest of the display
 * override). Every value is edited here and only here. Writes wait for the
 * page's one Save — the same footer the quick-detail modal uses. Role is
 * shown, not edited, on a spawned accessory child (`roleIsProviderOwned`).
 * Type is read-only.
 */
import type { DeviceInfo } from '@camstack/types'
import {
  Checkbox,
  deviceRoleMetaOf,
  SECTION_BODY,
  SECTION_CARD,
  Select,
  useUiText,
} from '@camstack/ui-library'
import type { UiTextFn } from '@camstack/ui-library'
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuickDetailSave } from '../quick-detail-save'
import { EditableNameRow } from '../overview-adapters/shared/EditableNameRow'
import { LocationRow } from '../overview-adapters/shared/LocationRow'
import { InfoRow } from '../overview-adapters/shared/overview-primitives'
import { IdentityDisplayFields } from './IdentityDisplayFields'
import { isKnownRole, roleIsProviderOwned, roleOptions } from './identity-model'

export interface IdentityRowProps {
  readonly device: DeviceInfo
}

export function IdentityRow({ device }: IdentityRowProps): ReactNode {
  const { t } = useTranslation()
  const uiText = useUiText()
  const save = useQuickDetailSave()
  const draft = save?.identity ?? null
  const name = draft?.name ?? device.name
  const location = draft?.location ?? device.location ?? ''
  const role = draft?.role ?? device.role ?? null
  const hidden = draft?.display.hidden ?? device.display?.hidden === true
  const bound = save !== null && draft !== null

  return (
    <section
      aria-label={t('customize.identity.title')}
      className={`${SECTION_CARD} ${SECTION_BODY}`}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {bound ? (
          <EditableNameRow
            deviceId={device.id}
            initialName={name}
            label={t('customize.identity.name')}
            layout="stacked"
            bound={{ value: name, onChange: save.setIdentityName }}
          />
        ) : (
          <InfoRow label={t('customize.identity.name')} layout="stacked" value={name} />
        )}
        {bound ? (
          <LocationRow
            deviceId={device.id}
            initialLocation={location}
            label={t('customize.identity.room')}
            layout="stacked"
            bound={{ value: location, onChange: save.setIdentityLocation }}
          />
        ) : (
          <InfoRow
            label={t('customize.identity.room')}
            layout="stacked"
            value={location === '' ? t('common.unset') : location}
          />
        )}
        <InfoRow label={t('customize.identity.type')} layout="stacked" value={device.type} />
        <InfoRow
          label={t('customize.identity.hidden')}
          layout="stacked"
          value={
            <Checkbox
              aria-label={t('deviceDisplay.hideFromLists')}
              checked={hidden}
              disabled={!bound}
              onChange={(e) => save?.setIdentityDisplay({ hidden: e.target.checked })}
            />
          }
        />
        <InfoRow
          label={t('customize.identity.role')}
          layout="stacked"
          value={
            roleIsProviderOwned(device) || !bound ? (
              <span>{roleLabel(role, t('customize.identity.noRole'), uiText)}</span>
            ) : (
              <Select
                aria-label={t('customize.identity.role')}
                value={role ?? ''}
                options={[
                  { value: '', label: t('customize.identity.noRole') },
                  ...roleOptions(role, device.type).map((option) => ({
                    value: option,
                    label: roleLabel(option, t('customize.identity.noRole'), uiText),
                  })),
                ]}
                onChange={(e) =>
                  save.setIdentityRole(e.target.value === '' ? null : e.target.value)
                }
              />
            )
          }
        />
      </div>
      {draft !== null && save !== null && (
        <IdentityDisplayFields
          device={device}
          role={role}
          display={draft.display}
          onChange={save.setIdentityDisplay}
        />
      )}
    </section>
  )
}

/** A known role by its label; any other stored string as itself; none as `noRole`. */
function roleLabel(role: string | null | undefined, noRole: string, uiText: UiTextFn): string {
  if (role === null || role === undefined || role === '') return noRole
  return isKnownRole(role) ? deviceRoleMetaOf(role, uiText).label : role
}
