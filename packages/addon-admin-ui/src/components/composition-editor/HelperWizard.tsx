/**
 * New or edit a group helper as its template (D944). Three steps: template,
 * reducer / name, members via the common source selector. Back keeps the
 * draft and never returns to the type list: the type is fixed once chosen.
 */
import {
  ACTIVE_CRITERIA,
  APPLIANCE_KINDS,
  APPLIANCE_TEMPLATE_ID,
  CALENDAR_PERIODS,
  groupTemplate,
  RESET_PERIODS,
  ROLLING_SPANS,
  type RollingSpan,
  STATISTIC_STATS,
} from '@camstack/types'
import { Button, Input, Select } from '@camstack/ui-library'
import { type ReactNode, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { SourceSelector } from '../device/customize/source-selector/SourceSelector'
import { devicePath } from '../../lib/customization-routes'
import { HelperTemplatePicker } from './HelperTemplatePicker'
import {
  canSaveDraft,
  draftForPick,
  type HelperDraft,
  type HelperFormDraft,
  type HelperSaveIntent,
  type HelperSaveResult,
  type HelperTemplatePick,
  type IntegralFormDraft,
  memberRequest,
  type RefusalLine,
  type StatisticFormDraft,
  withActive,
  withAggregate,
  withAppliance,
  withName,
  withTemplate,
} from './helper-form-model'

type WizardStep = 'template' | 'parameters' | 'members'

export interface HelperWizardProps {
  readonly initial: HelperDraft | null
  readonly start: WizardStep
  readonly purpose: 'create' | 'edit'
  readonly saving: boolean
  readonly onSave: (draft: HelperDraft, intent: HelperSaveIntent) => Promise<HelperSaveResult>
  readonly onDraftChange?: (draft: HelperDraft | null) => void
}

interface CreatedDevice {
  readonly deviceId: number
  readonly name: string
}

export function HelperWizard({
  initial,
  start,
  purpose,
  saving,
  onSave,
  onDraftChange,
}: HelperWizardProps): ReactNode {
  const { t } = useTranslation()
  const [step, setStep] = useState<WizardStep>(initial === null ? 'template' : start)
  const [draft, setDraft] = useState<HelperDraft | null>(initial)
  const [refusals, setRefusals] = useState<readonly RefusalLine[]>([])
  const [created, setCreated] = useState<CreatedDevice | null>(null)

  useEffect(() => {
    onDraftChange?.(draft)
  }, [draft, onDraftChange])

  const pick = (chosen: HelperTemplatePick): void => {
    setDraft((current) => {
      if (
        chosen.kind === 'group' &&
        current?.kind === 'group' &&
        current.templateId !== APPLIANCE_TEMPLATE_ID
      ) {
        return withTemplate(current, chosen.templateId)
      }
      return draftForPick(chosen)
    })
    setRefusals([])
    setCreated(null)
    setStep('parameters')
  }

  const save = (intent: HelperSaveIntent): void => {
    if (draft === null) return
    const savingDraft = draft
    void (async () => {
      const result = await onSave(savingDraft, intent)
      if (result.kind === 'refused') {
        setRefusals(result.lines)
        return
      }
      if (intent === 'again') {
        setCreated({ deviceId: result.deviceId, name: savingDraft.name.trim() })
        setDraft(null)
        setStep('template')
        setRefusals([])
      }
    })()
  }

  const request = draft === null ? null : memberRequest(draft)
  const template =
    draft !== null && draft.kind === 'group' && draft.templateId !== APPLIANCE_TEMPLATE_ID
      ? groupTemplate(draft.templateId)
      : null
  const members =
    draft === null
      ? []
      : draft.kind === 'group'
        ? draft.members
        : draft.source === null
          ? []
          : [draft.source]

  return (
    <div className="flex flex-col gap-3" data-testid="helper-wizard">
      {created !== null && (
        <p role="status" className="text-xs text-foreground" data-testid="helper-created">
          <Trans
            i18nKey="helper.created"
            values={{ name: created.name === '' ? t('helper.newHelper') : created.name }}
            components={{
              device: (
                <Link to={devicePath(created.deviceId)} className="text-primary hover:underline" />
              ),
            }}
          />
        </p>
      )}
      <p className="text-[11px] text-foreground-muted">{t(stepCopy(step, draft))}</p>
      {step === 'template' && <HelperTemplatePicker onPick={pick} />}
      {step === 'parameters' &&
        draft?.kind === 'group' &&
        draft.templateId === APPLIANCE_TEMPLATE_ID && (
          <ApplianceParameters draft={draft} onDraft={(next) => setDraft(next)} />
        )}
      {step === 'parameters' && draft?.kind === 'group' && template !== null && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {template.family === 'actuator' && draft.active !== null ? (
            <label className="flex flex-col gap-1 text-[11px]">
              {t('helper.criterion')}
              <Select
                aria-label={t('helper.criterion')}
                data-testid="helper-criterion"
                value={draft.active}
                onChange={(event) => {
                  const next = ACTIVE_CRITERIA.find((item) => item === event.target.value)
                  if (next !== undefined) setDraft(withActive(draft, next))
                }}
                options={ACTIVE_CRITERIA.map((item) => ({
                  value: item,
                  label: t(`helper.active.${item}`),
                }))}
              />
            </label>
          ) : (
            <label className="flex flex-col gap-1 text-[11px]">
              {t('helper.reducer')}
              <Select
                aria-label={t('helper.reducer')}
                data-testid="helper-reducer"
                value={draft.aggregate}
                onChange={(event) => {
                  const next = template.aggregates.find((item) => item === event.target.value)
                  if (next !== undefined) setDraft(withAggregate(draft, next))
                }}
                options={template.aggregates.map((item) => ({
                  value: item,
                  label: t(`helper.aggregate.${item}`),
                }))}
              />
            </label>
          )}
          <label className="flex flex-col gap-1 text-[11px]">
            {t('helper.name')}
            <Input
              aria-label={t('helper.name')}
              data-testid="helper-name"
              value={draft.name}
              onChange={(event) => setDraft(withName(draft, event.target.value))}
            />
          </label>
        </div>
      )}
      {step === 'parameters' && draft?.kind === 'statistic' && (
        <StatisticParameters draft={draft} onChange={setDraft} />
      )}
      {step === 'parameters' && draft?.kind === 'integral' && (
        <IntegralParameters draft={draft} onChange={setDraft} />
      )}
      {step === 'members' && draft !== null && request !== null && (
        <SourceSelector
          kind="members"
          request={request}
          enabled
          members={members}
          onMembersChange={(next) =>
            setDraft(
              draft.kind === 'group'
                ? { ...draft, members: next }
                : { ...draft, source: next[0] ?? null },
            )
          }
          onRefuse={(reason) =>
            setRefusals(
              reason === null
                ? []
                : [
                    {
                      path: 'helper.members',
                      code: 'member-constraint',
                      message: t('helper.maxMembers', { max: reason.max }),
                    },
                  ],
            )
          }
        />
      )}
      <RefusalList lines={refusals} />
      <div className="flex flex-wrap gap-2">
        {step === 'members' && (
          <Button variant="ghost" onClick={() => setStep('parameters')}>
            {t('helper.back')}
          </Button>
        )}
        {step === 'parameters' && draft !== null && (
          <Button
            data-testid="helper-to-members"
            disabled={draft.name.trim() === ''}
            onClick={() => {
              setRefusals([])
              setStep('members')
            }}
          >
            {t('helper.next')}
          </Button>
        )}
        {step === 'members' && draft !== null && purpose === 'edit' && (
          <Button
            data-testid="helper-save"
            disabled={!canSaveDraft(draft) || saving}
            onClick={() => save('open')}
          >
            {t('helper.save')}
          </Button>
        )}
        {step === 'members' && draft !== null && purpose === 'create' && (
          <>
            <Button
              data-testid="helper-save-open"
              disabled={!canSaveDraft(draft) || saving}
              onClick={() => save('open')}
            >
              {t('helper.saveOpen')}
            </Button>
            <Button
              variant="outline"
              data-testid="helper-save-more"
              disabled={!canSaveDraft(draft) || saving}
              onClick={() => save('again')}
            >
              {t('helper.saveMore')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

const MS_PER_MINUTE = 60_000

interface ApplianceParametersProps {
  readonly draft: HelperFormDraft
  readonly onDraft: (draft: HelperFormDraft) => void
}

function ApplianceParameters({ draft, onDraft }: ApplianceParametersProps): ReactNode {
  const { t } = useTranslation()
  const kind = draft.appliance ?? 'washer'
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-[11px]">
        {t('helper.applianceType')}
        <Select
          aria-label={t('helper.applianceType')}
          data-testid="helper-appliance"
          value={kind}
          onChange={(event) => {
            const next = APPLIANCE_KINDS.find((item) => item === event.target.value)
            if (next !== undefined) onDraft(withAppliance(draft, next))
          }}
          options={APPLIANCE_KINDS.map((item) => ({
            value: item,
            label: t(`helper.appliance.${item}`),
          }))}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px]">
        {t('helper.name')}
        <Input
          aria-label={t('helper.name')}
          data-testid="helper-name"
          value={draft.name}
          onChange={(event) => onDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <NumberField
        label={t('helper.threshold')}
        testId="helper-threshold"
        value={String(draft.thresholdWatts)}
        onValue={(text) => {
          const watts = positiveNumber(text)
          if (watts !== null) onDraft({ ...draft, thresholdWatts: watts })
        }}
      />
      <NumberField
        label={t('helper.startDwell')}
        testId="helper-start-dwell"
        value={minutesText(draft.startDwellMs)}
        onValue={(text) => {
          const ms = msFromMinutes(text)
          if (ms !== null) onDraft({ ...draft, startDwellMs: ms })
        }}
      />
      <NumberField
        label={t('helper.stopDwell')}
        testId="helper-stop-dwell"
        value={minutesText(draft.stopDwellMs)}
        onValue={(text) => {
          const ms = msFromMinutes(text)
          if (ms !== null) onDraft({ ...draft, stopDwellMs: ms })
        }}
      />
    </div>
  )
}

function minutesText(ms: number): string {
  return String(ms / MS_PER_MINUTE)
}

function msFromMinutes(text: string): number | null {
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * MS_PER_MINUTE)
}

function positiveNumber(text: string): number | null {
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}

interface NumberFieldProps {
  readonly label: string
  readonly testId: string
  readonly value: string
  readonly onValue: (text: string) => void
}

function NumberField({ label, testId, value, onValue }: NumberFieldProps): ReactNode {
  return (
    <label className="flex flex-col gap-1 text-[11px]">
      {label}
      <Input
        type="number"
        min={0}
        step="any"
        aria-label={label}
        data-testid={testId}
        value={value}
        onChange={(event) => onValue(event.target.value)}
      />
    </label>
  )
}

function StatisticParameters({
  draft,
  onChange,
}: {
  readonly draft: StatisticFormDraft
  readonly onChange: (draft: StatisticFormDraft) => void
}): ReactNode {
  const { t } = useTranslation()
  const rolling = draft.window.kind === 'rolling'
  return (
    <div
      className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      data-testid="helper-statistic-parameters"
    >
      <Field label={t('helper.stat')}>
        <Select
          aria-label={t('helper.stat')}
          data-testid="helper-stat"
          value={draft.stat}
          onChange={(event) => {
            const stat = STATISTIC_STATS.find((item) => item === event.target.value)
            if (stat !== undefined) onChange({ ...draft, stat })
          }}
          options={STATISTIC_STATS.map((item) => ({
            value: item,
            label: t(`helper.statName.${item}`),
          }))}
        />
      </Field>
      <Field label={t('helper.range')}>
        <Select
          aria-label={t('helper.range')}
          data-testid="helper-range-kind"
          value={draft.window.kind}
          onChange={(event) => {
            if (event.target.value === 'calendar')
              onChange({ ...draft, window: { kind: 'calendar', period: 'today' } })
            if (event.target.value === 'rolling')
              onChange({ ...draft, window: { kind: 'rolling', span: '24h' } })
          }}
          options={[
            { value: 'rolling', label: t('helper.rangeKind.rolling') },
            { value: 'calendar', label: t('helper.rangeKind.calendar') },
          ]}
        />
      </Field>
      {rolling ? (
        <Field label={t('helper.span')}>
          <Select
            aria-label={t('helper.span')}
            data-testid="helper-span"
            value={draft.window.span}
            onChange={(event) => {
              const span = ROLLING_SPANS.find((item) => item === event.target.value)
              if (span !== undefined) onChange({ ...draft, window: rollingWindow(span, draft) })
            }}
            options={ROLLING_SPANS.map((item) => ({
              value: item,
              label: t(`helper.spanName.${item}`),
            }))}
          />
        </Field>
      ) : (
        <Field label={t('helper.period')}>
          <Select
            aria-label={t('helper.period')}
            data-testid="helper-period"
            value={draft.window.period}
            onChange={(event) => {
              const period = CALENDAR_PERIODS.find((item) => item === event.target.value)
              if (period !== undefined) onChange({ ...draft, window: { kind: 'calendar', period } })
            }}
            options={CALENDAR_PERIODS.map((item) => ({
              value: item,
              label: t(`helper.periodName.${item}`),
            }))}
          />
        </Field>
      )}
      {draft.window.kind === 'rolling' && draft.window.span === 'custom' && (
        <Field label={t('helper.customMinutes')}>
          <Input
            aria-label={t('helper.customMinutes')}
            data-testid="helper-custom-minutes"
            inputMode="numeric"
            value={
              draft.window.customMinutes === undefined ? '' : String(draft.window.customMinutes)
            }
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10)
              onChange({
                ...draft,
                window: {
                  kind: 'rolling',
                  span: 'custom',
                  ...(Number.isFinite(parsed) ? { customMinutes: parsed } : {}),
                },
              })
            }}
          />
        </Field>
      )}
      <NameField name={draft.name} onChange={(name) => onChange({ ...draft, name })} />
    </div>
  )
}

function rollingWindow(span: RollingSpan, draft: StatisticFormDraft): StatisticFormDraft['window'] {
  if (span !== 'custom') return { kind: 'rolling', span }
  const minutes = draft.window.kind === 'rolling' ? draft.window.customMinutes : undefined
  return minutes === undefined
    ? { kind: 'rolling', span }
    : { kind: 'rolling', span, customMinutes: minutes }
}

function IntegralParameters({
  draft,
  onChange,
}: {
  readonly draft: IntegralFormDraft
  readonly onChange: (draft: IntegralFormDraft) => void
}): ReactNode {
  const { t } = useTranslation()
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="helper-integral-parameters">
      <Field label={t('helper.reset')}>
        <Select
          aria-label={t('helper.reset')}
          data-testid="helper-reset"
          value={draft.reset}
          onChange={(event) => {
            const reset = RESET_PERIODS.find((item) => item === event.target.value)
            if (reset !== undefined) onChange({ ...draft, reset })
          }}
          options={RESET_PERIODS.map((item) => ({
            value: item,
            label: t(`helper.resetName.${item}`),
          }))}
        />
      </Field>
      <NameField name={draft.name} onChange={(name) => onChange({ ...draft, name })} />
    </div>
  )
}

function NameField({
  name,
  onChange,
}: {
  readonly name: string
  readonly onChange: (name: string) => void
}): ReactNode {
  const { t } = useTranslation()
  return (
    <Field label={t('helper.name')}>
      <Input
        aria-label={t('helper.name')}
        data-testid="helper-name"
        value={name}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}

function stepCopy(step: WizardStep, draft: HelperDraft | null): string {
  if (draft?.kind === 'statistic' || draft?.kind === 'integral') {
    if (step === 'parameters') return 'helper.step.historyParameters'
    if (step === 'members') return 'helper.step.historySource'
  }
  if (draft?.kind === 'group' && draft.templateId === APPLIANCE_TEMPLATE_ID) {
    if (step === 'parameters') return 'helper.step.appliance'
    if (step === 'members') return 'helper.step.applianceMembers'
  }
  return `helper.step.${step}`
}

function Field({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <label className="flex flex-col gap-1 text-[11px]">
      {label}
      {children}
    </label>
  )
}

function RefusalList({ lines }: { readonly lines: readonly RefusalLine[] }): ReactNode {
  if (lines.length === 0) return null
  return (
    <ul role="alert" className="flex flex-col gap-1" data-testid="helper-refusals">
      {lines.map((line) => (
        <li key={`${line.path}:${line.code}:${line.message}`} className="text-xs text-danger">
          <span className="font-medium">{line.code}</span>
          {line.message === '' ? '' : ` — ${line.message}`}
        </li>
      ))}
    </ul>
  )
}
