/**
 * New or edit a group helper as its template (D944). Three steps: template,
 * reducer / name, members via the common source selector. Back keeps the
 * draft. A different template replaces it.
 */
import {
  ACTIVE_CRITERIA,
  APPLIANCE_KINDS,
  APPLIANCE_TEMPLATE_ID,
  groupTemplate,
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
  draftForTemplate,
  type HelperFormDraft,
  type HelperPickerId,
  type HelperSaveIntent,
  type HelperSaveResult,
  memberRequest,
  type RefusalLine,
  withActive,
  withAggregate,
  withAppliance,
  withName,
  withTemplate,
} from './helper-form-model'

type WizardStep = 'template' | 'parameters' | 'members'

export interface HelperWizardProps {
  readonly initial: HelperFormDraft | null
  readonly start: WizardStep
  readonly purpose: 'create' | 'edit'
  readonly saving: boolean
  readonly onSave: (draft: HelperFormDraft, intent: HelperSaveIntent) => Promise<HelperSaveResult>
  readonly onDraftChange?: (draft: HelperFormDraft | null) => void
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
  const [draft, setDraft] = useState<HelperFormDraft | null>(initial)
  const [refusals, setRefusals] = useState<readonly RefusalLine[]>([])
  const [created, setCreated] = useState<CreatedDevice | null>(null)

  useEffect(() => {
    onDraftChange?.(draft)
  }, [draft, onDraftChange])

  const pickTemplate = (templateId: HelperPickerId): void => {
    setDraft((current) =>
      current === null ? draftForTemplate(templateId) : withTemplate(current, templateId),
    )
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
    draft === null || draft.templateId === APPLIANCE_TEMPLATE_ID
      ? null
      : groupTemplate(draft.templateId)
  const stepKey =
    draft?.templateId === APPLIANCE_TEMPLATE_ID && step === 'parameters'
      ? 'helper.step.appliance'
      : draft?.templateId === APPLIANCE_TEMPLATE_ID && step === 'members'
        ? 'helper.step.applianceMembers'
        : `helper.step.${step}`

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
      <p className="text-[11px] text-foreground-muted">{t(stepKey)}</p>
      {step === 'template' && <HelperTemplatePicker onPick={pickTemplate} />}
      {step === 'parameters' && draft !== null && draft.templateId === APPLIANCE_TEMPLATE_ID && (
        <ApplianceParameters draft={draft} onDraft={(next) => setDraft(next)} />
      )}
      {step === 'parameters' && draft !== null && template !== null && (
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
      {step === 'members' && draft !== null && request !== null && (
        <SourceSelector
          kind="members"
          request={request}
          enabled
          members={draft.members}
          onMembersChange={(members) => setDraft({ ...draft, members })}
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
        {step !== 'template' && (
          <Button
            variant="ghost"
            onClick={() => setStep(step === 'members' ? 'parameters' : 'template')}
          >
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
          onChange={(event) => onDraft(withName(draft, event.target.value))}
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
