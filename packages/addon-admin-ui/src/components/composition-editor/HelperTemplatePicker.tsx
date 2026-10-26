/**
 * Group templates as tiles: the device-type icon and the name.
 * What the template can do sits on the info control, not under the name.
 */
import {
  ACTIVE_CRITERIA,
  APPLIANCE_TEMPLATE_ID,
  DeviceType,
  GROUP_TEMPLATE_IDS,
  type GroupTemplateId,
  groupTemplate,
} from '@camstack/types'
import { deviceRoleMeta, deviceTypeMeta, GroupedTilePicker } from '@camstack/ui-library'
import type { TFunction } from 'i18next'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { helperTemplateGroups, type HelperPickerId } from './helper-form-model'

export interface HelperTemplatePickerProps {
  readonly onPick: (templateId: HelperPickerId) => void
}

export function HelperTemplatePicker({ onPick }: HelperTemplatePickerProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div data-testid="helper-template-picker">
      <GroupedTilePicker
        emptyMessage={t('helper.noTemplates')}
        onPick={(key) => {
          if (!isPickerId(key)) return
          onPick(key)
        }}
        groups={pickerGroups(t)}
      />
    </div>
  )
}

function isGroupTemplateId(value: string): value is GroupTemplateId {
  return GROUP_TEMPLATE_IDS.some((id) => id === value)
}

function isPickerId(value: string): value is HelperPickerId {
  return value === APPLIANCE_TEMPLATE_ID || isGroupTemplateId(value)
}

interface PickerTile {
  readonly key: string
  readonly label: string
  readonly testId: string
  readonly icon: ReactNode
  readonly detailLabel: string
  readonly detail: ReactNode
}

interface PickerGroup {
  readonly id: string
  readonly label: string
  readonly tiles: readonly PickerTile[]
}

function pickerGroups(t: TFunction): readonly PickerGroup[] {
  return helperTemplateGroups().map((group) => ({
    id: group.id,
    label: t(`helper.group.${group.id}`),
    tiles: tilesOf(group.templateIds, t),
  }))
}

function tilesOf(ids: readonly HelperPickerId[], t: TFunction): readonly PickerTile[] {
  const tiles: PickerTile[] = []
  for (const id of ids) {
    const tile = tileOf(id, t)
    if (tile !== null) tiles.push(tile)
  }
  return tiles
}

function tileOf(id: HelperPickerId, t: TFunction): PickerTile | null {
  if (id === APPLIANCE_TEMPLATE_ID) return applianceTile(t)
  if (!isGroupTemplateId(id)) return null
  const template = groupTemplate(id)
  if (template === null) return null
  const label = t(`helper.template.${id}`)
  const Icon =
    template.role === undefined
      ? deviceTypeMeta(template.deviceType).icon
      : deviceRoleMeta(template.role).icon
  return {
    key: id,
    label,
    testId: `helper-template-${id}`,
    icon: <Icon className="h-5 w-5 text-foreground-muted" aria-hidden />,
    detailLabel: t('helper.detailsOf', { name: label }),
    detail: <TemplateDetail templateId={id} />,
  }
}

function applianceTile(t: TFunction): PickerTile {
  const label = t('helper.template.appliance')
  const Icon = deviceTypeMeta(DeviceType.Washer).icon
  return {
    key: APPLIANCE_TEMPLATE_ID,
    label,
    testId: 'helper-template-appliance',
    icon: <Icon className="h-5 w-5 text-foreground-muted" aria-hidden />,
    detailLabel: t('helper.detailsOf', { name: label }),
    detail: <ApplianceDetail />,
  }
}

function ApplianceDetail(): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="max-w-xs text-xs">
      <p className="text-foreground-muted">{t('helper.template.applianceSummary')}</p>
    </div>
  )
}

function TemplateDetail({ templateId }: { readonly templateId: GroupTemplateId }): ReactNode {
  const { t } = useTranslation()
  const template = groupTemplate(templateId)
  if (template === null) return null
  const operations =
    template.family === 'actuator'
      ? ACTIVE_CRITERIA.map((item) => t(`helper.active.${item}`))
      : template.aggregates.map((item) => t(`helper.aggregate.${item}`))
  const shared = template.commandCaps.filter((cap) => cap !== 'switch')
  return (
    <div className="max-w-xs space-y-1 text-xs">
      <p className="font-medium text-foreground">{t('helper.supportedOperations')}</p>
      <p className="text-foreground-muted">{operations.join(', ')}</p>
      {shared.length > 0 && (
        <>
          <p className="font-medium text-foreground">{t('helper.sharedCaps')}</p>
          <p className="text-foreground-muted">
            {shared.map((cap) => t(`helper.cap.${cap}`)).join(', ')}
          </p>
        </>
      )}
      <p className="text-foreground-subtle">{t('helper.offlineCounted')}</p>
    </div>
  )
}
