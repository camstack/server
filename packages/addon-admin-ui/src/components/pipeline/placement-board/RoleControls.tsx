/**
 * RoleControls — the singleton cluster roles (Ingest / Recording / Audio /
 * Motion / Post-processing): exactly one node holds each, for every camera.
 * One row per role, the library `Select` naming each node by its display name.
 * The low-fps relocate policy lives with the other reactive load policies on
 * the Load balancing tab (D748).
 */
import { LIST_ROW, Select, TEXT_HINT } from '@camstack/ui-library'
import { ROLE_FIELDS, roleHint, roleLabel, type RoleField } from './board-model'
import { useTranslation } from 'react-i18next'

export interface RoleNodeOption {
  readonly id: string
  readonly name: string
}

export interface RoleControlsProps {
  readonly roleValues: Readonly<Record<RoleField, string>>
  /** Selectable nodes: every online node, plus any node a role is set to. */
  readonly options: readonly RoleNodeOption[]
  readonly pending: boolean
  readonly onRoleChange: (role: RoleField, nodeId: string) => void
}

export function RoleControls({ roleValues, options, pending, onRoleChange }: RoleControlsProps) {
  const { t } = useTranslation()
  const selectOptions = options.map((node) => ({
    value: node.id,
    label:
      node.id === 'hub'
        ? t('placementBoard.roleControls.default', '{{name}} (default)', { name: node.name })
        : node.name,
  }))
  return (
    <ul className="divide-y divide-border">
      {ROLE_FIELDS.map((role) => (
        <li key={role} className={`${LIST_ROW} flex flex-wrap items-center gap-x-3 gap-y-1.5`}>
          <div className="min-w-0 flex-1 basis-56">
            <div className="text-xs font-medium text-foreground">{roleLabel(role)}</div>
            <p className={TEXT_HINT}>{roleHint(role)}</p>
          </div>
          <div className="w-full sm:w-48">
            <Select
              aria-label={t('placementBoard.roleControls.node', '{{value1}} node', {
                value1: roleLabel(role),
              })}
              value={roleValues[role]}
              disabled={pending}
              options={selectOptions}
              onChange={(event) => onRoleChange(role, event.target.value)}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}
