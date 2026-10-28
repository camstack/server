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
import { BarChart3, Blocks, Divide, Gauge, Minus, Plus, Sigma, TrendingUp, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  calculationTileIds,
  helperTemplateGroups,
  type HelperPickerId,
  type HelperTemplatePick,
  isMathTileId,
  type MathTileId,
  pickForMathTile,
} from './helper-form-model'

export interface HelperTemplatePickerProps {
  readonly onPick: (pick: HelperTemplatePick) => void
  /** The Advanced "Free composition" tile; omitted where only helpers are offered. */
  readonly onFreeComposition?: () => void
}

const FREE_COMPOSITION_KEY = 'composition'

export function HelperTemplatePicker({
  onPick,
  onFreeComposition,
}: HelperTemplatePickerProps): ReactNode {
  const { t } = useTranslation()
  return (
    <div data-testid="helper-template-picker">
      <GroupedTilePicker
        emptyMessage={t('helper.noTemplates')}
        onPick={(key) => {
          if (key === FREE_COMPOSITION_KEY) {
            onFreeComposition?.()
            return
          }
          if (key === 'statistic' || key === 'integral') {
            onPick({ kind: key })
            return
          }
          if (key === APPLIANCE_TEMPLATE_ID) {
            onPick({ kind: 'appliance' })
            return
          }
          if (isMathTileId(key)) {
            onPick(pickForMathTile(key))
            return
          }
          if (!isGroupTemplateId(key)) return
          onPick({ kind: 'group', templateId: key })
        }}
        groups={[
          ...pickerGroups(t),
          {
            id: 'calculation',
            label: t('helper.section.calculation'),
            tiles: [
              ...calculationTileIds().map((id) => mathTile(id, t)),
              historyTile('statistic', BarChart3, t),
              historyTile('integral', Zap, t),
            ],
          },
          {
            id: 'advanced',
            label: t('helper.section.advanced'),
            tiles: [
              ...(onFreeComposition === undefined ? [] : [compositionTile(t)]),
              mathTile('expression', t),
            ],
          },
        ]}
      />
    </div>
  )
}

function compositionTile(t: TFunction): PickerTile {
  const label = t('helper.template.composition')
  return {
    key: FREE_COMPOSITION_KEY,
    label,
    testId: 'helper-template-composition',
    icon: <Blocks className="h-5 w-5 text-foreground-muted" aria-hidden />,
    detailLabel: t('helper.detailsOf', { name: label }),
    detail: (
      <div className="max-w-xs text-xs">
        <p className="text-foreground-muted">{t('helper.detail.composition')}</p>
      </div>
    ),
  }
}

function historyTile(
  id: 'statistic' | 'integral',
  Icon: typeof BarChart3,
  t: (key: string, options?: { readonly name: string }) => string,
): {
  readonly key: string
  readonly label: string
  readonly testId: string
  readonly icon: ReactNode
  readonly detailLabel: string
  readonly detail: ReactNode
} {
  const label = t(`helper.template.${id}`)
  return {
    key: id,
    label,
    testId: `helper-template-${id}`,
    icon: <Icon className="h-5 w-5 text-foreground-muted" aria-hidden />,
    detailLabel: t('helper.detailsOf', { name: label }),
    detail: <HistoryDetail id={id} />,
  }
}

const MATH_ICONS: Readonly<Record<MathTileId, typeof Gauge>> = {
  threshold: Gauge,
  sum: Plus,
  difference: Minus,
  ratio: Divide,
  expression: Sigma,
  derivative: TrendingUp,
}

function mathTile(id: MathTileId, t: TFunction): PickerTile {
  const label = t(`helper.template.${id}`)
  const Icon = MATH_ICONS[id]
  return {
    key: id,
    label,
    testId: `helper-template-${id}`,
    icon: <Icon className="h-5 w-5 text-foreground-muted" aria-hidden />,
    detailLabel: t('helper.detailsOf', { name: label }),
    detail: <MathDetail id={id} />,
  }
}

function MathDetail({ id }: { readonly id: MathTileId }): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="max-w-xs space-y-1 text-xs">
      <p className="text-foreground-muted">{t(`helper.detail.${id}`)}</p>
      {id === 'derivative' && (
        <p className="text-foreground-subtle">{t('helper.detail.history')}</p>
      )}
      {id === 'expression' && (
        <p className="text-foreground-subtle">{t('helper.detail.expressionStale')}</p>
      )}
    </div>
  )
}

function HistoryDetail({ id }: { readonly id: 'statistic' | 'integral' }): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="max-w-xs space-y-1 text-xs">
      <p className="text-foreground-muted">{t(`helper.detail.${id}`)}</p>
      <p className="text-foreground-subtle">{t('helper.detail.history')}</p>
    </div>
  )
}

function isGroupTemplateId(value: string): value is GroupTemplateId {
  return GROUP_TEMPLATE_IDS.some((id) => id === value)
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
    label: `${t('helper.section.group')} · ${t(`helper.group.${group.id}`)}`,
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
      {template.id === 'lock' && (
        <p className="text-foreground-subtle">{t('helper.detail.lockConfirm')}</p>
      )}
      <p className="text-foreground-subtle">{t('helper.offlineCounted')}</p>
    </div>
  )
}
