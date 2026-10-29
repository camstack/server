/**
 * A helper's Customize section: what it computes and from which members,
 * read-only. Editing happens in the helper dialog (the Edit action).
 */
import type { DeviceInfo } from '@camstack/types'
import { Button, DeviceName, SECTION_BODY, SectionCard, SettingRow } from '@camstack/ui-library'
import { Pencil } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useDeviceList } from '../../../hooks/useDevice'
import { type HelperDraft, draftMembers } from '../../composition-editor/helper-form-model'
import { vocabularyFieldLabel } from './vocabulary-field-label'

export interface HelperSummaryCardProps {
  readonly draft: HelperDraft
  readonly device: DeviceInfo
  readonly onEdit: () => void
}

type Translate = (key: string) => string

interface SummaryRow {
  readonly label: string
  readonly value: string
}

function functionLabel(draft: HelperDraft, t: Translate): string {
  switch (draft.kind) {
    case 'group':
      return draft.active !== null
        ? t(`helper.active.${draft.active}`)
        : t(`helper.aggregate.${draft.aggregate}`)
    case 'statistic':
      return t(`helper.statName.${draft.stat}`)
    case 'integral':
    case 'threshold':
    case 'derivative':
      return t(`helper.template.${draft.kind}`)
    case 'arithmetic':
      return t(`helper.template.${draft.op}`)
    case 'expression':
      return draft.expr
  }
}

function parameterRows(draft: HelperDraft, t: Translate): readonly SummaryRow[] {
  switch (draft.kind) {
    case 'integral':
      return [
        {
          label: t('helper.reset'),
          value: t(`helper.resetName.${draft.reset}`),
        },
      ]
    case 'threshold':
      return [
        { label: t('helper.highEdge'), value: String(draft.high) },
        { label: t('helper.lowEdge'), value: String(draft.low) },
      ]
    case 'derivative':
      return [{ label: t('helper.per'), value: t(`helper.perName.${draft.per}`) }]
    default:
      return []
  }
}

export function HelperSummaryCard({ draft, device, onEdit }: HelperSummaryCardProps): ReactNode {
  const { t, i18n } = useTranslation()
  const fleet = useDeviceList()
  const members = draftMembers(draft)
  const rows = parameterRows(draft, (key) => t(key))
  return (
    <SectionCard
      headingId={`helper-summary-${device.id}`}
      title={t('customize.composed.helper.title')}
      testId="helper-summary"
      actions={
        <Button variant="outline" size="sm" onClick={onEdit} data-testid="helper-summary-edit">
          <Pencil className="h-3 w-3" aria-hidden />
          {t('common.edit')}
        </Button>
      }
    >
      <div className={SECTION_BODY}>
        <SettingRow label={t('customize.composed.helper.function')}>
          {functionLabel(draft, (key) => t(key))}
        </SettingRow>
        {rows.map((row) => (
          <SettingRow key={row.label} label={row.label}>
            {row.value}
          </SettingRow>
        ))}
        {members.length > 0 && (
          <SettingRow label={t('customize.composed.helper.members')}>
            <ul className="flex flex-col gap-0.5" data-testid="helper-summary-members">
              {members.map((member) => {
                const source = fleet.data?.find(
                  (d) =>
                    d.addonId === member.source.addonId && d.stableId === member.source.stableId,
                )
                return (
                  <li
                    key={`${member.source.addonId}:${member.source.stableId}:${member.cap}:${member.fieldPath}`}
                    className="flex flex-wrap items-baseline gap-x-1.5"
                  >
                    {source !== undefined ? (
                      <DeviceName device={source} form="compact" />
                    ) : (
                      <span>{member.source.stableId}</span>
                    )}
                    <span className="text-foreground-muted">
                      {vocabularyFieldLabel(member.cap, member.fieldPath, i18n.language)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </SettingRow>
        )}
      </div>
    </SectionCard>
  )
}
