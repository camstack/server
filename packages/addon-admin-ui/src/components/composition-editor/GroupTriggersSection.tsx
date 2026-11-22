/**
 * The Triggers of an actuator group, on its Customize screen: what happens
 * (a button press, an event) and what the group does about it (on, off, switch,
 * a climate mode). The section stores nothing of its own — it edits the
 * group's helper spec through `save`, and the backend's refusal (a loop, a
 * trigger on nothing, a `none` group with no trigger) is shown by name.
 */
import {
  type Composition,
  compositionSourceKey,
  type CompositionSourceRef,
  EventCategory,
  HvacModeSchema,
  type GroupTrigger,
  type GroupTriggerAction,
} from '@camstack/types'
import { Badge, Button, Input, Select } from '@camstack/ui-library'
import { Zap } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomizeCard } from '../device/customize/CustomizeCard'
import { CustomizeDevicePickerDialog } from '../device/customize/assignments/CustomizeDevicePickerDialog'
import { useCandidateDevices } from '../device/customize/assignments/use-source-candidates'
import type { CustomizationSaveOutcome } from '../device/customize/use-customization'
import { deviceCandidates } from './command-sources'
import {
  actionSummary,
  isEditableSource,
  MAX_GROUP_TRIGGERS,
  nextTriggerId,
  offeredActions,
  sourceSummary,
  triggerEnabled,
  withEnabled,
  withoutTrigger,
  withTrigger,
} from './group-triggers-model'
import { RefusalList } from './RefusalList'

export interface GroupTriggersSectionProps {
  readonly composition: Composition
  readonly saving: boolean
  readonly save: (next: Composition) => Promise<CustomizationSaveOutcome>
}

type SourceKind = 'fired' | 'event'

interface TriggerDraft {
  readonly id: string
  readonly kind: SourceKind
  readonly device: CompositionSourceRef | null
  readonly events: string
  readonly category: EventCategory
  readonly action: GroupTriggerAction['kind']
  readonly mode: string
}

/** The group types a trigger can command (the backend refuses the rest by name). */
const TRIGGER_TEMPLATES: ReadonlySet<string> = new Set(['switch', 'light', 'fan', 'climate'])

const CATEGORIES: readonly EventCategory[] = Object.values(EventCategory)

function actionOf(draft: TriggerDraft): GroupTriggerAction {
  if (draft.action === 'on') return { kind: 'on' }
  if (draft.action === 'off') return { kind: 'off' }
  if (draft.action === 'switch') return { kind: 'switch' }
  const mode = HvacModeSchema.safeParse(draft.mode)
  return mode.success ? { kind: 'climate', mode: mode.data } : { kind: 'climate' }
}

function toTrigger(draft: TriggerDraft): GroupTrigger | null {
  const action = actionOf(draft)
  if (draft.kind === 'fired') {
    if (draft.device === null) return null
    const eventIds = draft.events
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e !== '')
    return {
      id: draft.id,
      source: {
        kind: 'fired',
        device: draft.device,
        ...(eventIds.length === 0 ? {} : { eventIds }),
      },
      action,
    }
  }
  return {
    id: draft.id,
    source: {
      kind: 'event',
      category: draft.category,
      ...(draft.device === null ? {} : { device: draft.device }),
    },
    action,
  }
}

export function GroupTriggersSection({
  composition,
  saving,
  save,
}: GroupTriggersSectionProps): ReactNode {
  const { t } = useTranslation()
  const helper = composition.helper
  const fleet = useCandidateDevices(true)
  const [draft, setDraft] = useState<TriggerDraft | null>(null)
  const [picking, setPicking] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const names = useMemo(
    () =>
      fleet.kind === 'known'
        ? new Map(
            fleet.value.map((d) => [
              compositionSourceKey({
                addonId: d.addonId,
                stableId: d.stableId,
              }),
              d.name,
            ]),
          )
        : new Map<string, string>(),
    [fleet],
  )
  const candidates = useMemo(
    () =>
      fleet.kind === 'known'
        ? ({ kind: 'known', value: deviceCandidates(fleet.value) } as const)
        : fleet,
    [fleet],
  )

  if (helper === undefined || helper.kind !== 'group') return null
  if (!TRIGGER_TEMPLATES.has(helper.templateId)) return null
  const triggers = helper.triggers ?? []
  const nameOf = (ref: CompositionSourceRef): string =>
    names.get(compositionSourceKey(ref)) ?? ref.stableId
  const actions = offeredActions(helper.templateId)

  const commit = async (next: readonly GroupTrigger[]): Promise<boolean> => {
    setRefusal(null)
    const outcome = await save({
      ...composition,
      helper: { ...helper, triggers: [...next] },
    })
    if (outcome.kind === 'refused') {
      setRefusal(outcome.reason)
      return false
    }
    return true
  }

  const startDraft = (): void =>
    setDraft({
      id: nextTriggerId(triggers),
      kind: 'fired',
      device: null,
      events: '',
      category: CATEGORIES[0] ?? EventCategory.DeviceStateChanged,
      action: actions[0] ?? 'on',
      mode: '',
    })

  const apply = async (): Promise<void> => {
    if (draft === null) return
    const next = toTrigger(draft)
    if (next === null) return
    if (await commit(withTrigger(triggers, next))) setDraft(null)
  }

  return (
    <CustomizeCard
      id="group-triggers"
      icon={Zap}
      title={t('groupTriggers.title')}
      testId="group-triggers-card"
    >
      <div className="flex flex-col gap-3 px-3 py-2 sm:px-4">
        <p className="text-xs text-foreground-muted">{t('groupTriggers.hint')}</p>
        {triggers.length === 0 && (
          <p className="text-xs text-foreground-muted" data-testid="group-triggers-empty">
            {t('groupTriggers.empty')}
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {triggers.map((trigger) => (
            <li
              key={trigger.id}
              data-testid={`group-trigger-${trigger.id}`}
              className="flex flex-wrap items-center gap-2 text-xs"
            >
              <span className="min-w-0 flex-1 break-words">
                {sourceSummary(trigger.source, nameOf)} → {actionSummary(trigger.action)}
              </span>
              {!triggerEnabled(trigger) && (
                <Badge variant="warning">{t('groupTriggers.off')}</Badge>
              )}
              {!isEditableSource(trigger.source) && (
                <Badge variant="info">{t('groupTriggers.keptAsIs')}</Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() =>
                  void commit(withEnabled(triggers, trigger.id, !triggerEnabled(trigger)))
                }
              >
                {triggerEnabled(trigger) ? t('groupTriggers.disable') : t('groupTriggers.enable')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => void commit(withoutTrigger(triggers, trigger.id))}
              >
                {t('groupTriggers.remove')}
              </Button>
            </li>
          ))}
        </ul>
        {draft === null ? (
          <div>
            <Button
              size="sm"
              disabled={saving || triggers.length >= MAX_GROUP_TRIGGERS}
              onClick={startDraft}
              data-testid="group-trigger-add"
            >
              {t('groupTriggers.add')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2" data-testid="group-trigger-draft">
            <Select
              aria-label={t('groupTriggers.source')}
              value={draft.kind}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  kind: event.target.value === 'event' ? 'event' : 'fired',
                })
              }
              options={[
                { value: 'fired', label: t('groupTriggers.sourceFired') },
                { value: 'event', label: t('groupTriggers.sourceEvent') },
              ]}
            />
            {draft.kind === 'event' && (
              <Select
                aria-label={t('groupTriggers.category')}
                value={draft.category}
                onChange={(event) => {
                  const next = CATEGORIES.find((c) => c === event.target.value)
                  if (next !== undefined) setDraft({ ...draft, category: next })
                }}
                options={CATEGORIES.map((c) => ({ value: c, label: c }))}
              />
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
                {draft.device === null ? t('groupTriggers.pickDevice') : nameOf(draft.device)}
              </Button>
            </div>
            {draft.kind === 'fired' && (
              <Input
                aria-label={t('groupTriggers.events')}
                placeholder={t('groupTriggers.eventsPlaceholder')}
                value={draft.events}
                onChange={(event) => setDraft({ ...draft, events: event.target.value })}
              />
            )}
            <Select
              aria-label={t('groupTriggers.action')}
              value={draft.action}
              onChange={(event) => {
                const next = actions.find((a) => a === event.target.value)
                if (next !== undefined) setDraft({ ...draft, action: next })
              }}
              options={actions.map((a) => ({
                value: a,
                label: t(`groupTriggers.actions.${a}`),
              }))}
            />
            {draft.action === 'climate' && (
              <Input
                aria-label={t('groupTriggers.mode')}
                value={draft.mode}
                onChange={(event) => setDraft({ ...draft, mode: event.target.value })}
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={saving || toTrigger(draft) === null}
                onClick={() => void apply()}
              >
                {t('groupTriggers.apply')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                {t('groupTriggers.cancel')}
              </Button>
            </div>
          </div>
        )}
        {refusal !== null && (
          <RefusalList
            testId="group-triggers-refusal"
            lines={[{ path: 'helper.triggers', code: 'refused', message: refusal }]}
          />
        )}
      </div>
      <CustomizeDevicePickerDialog
        open={picking}
        title={t('groupTriggers.pickDevice')}
        selection="single"
        candidates={candidates}
        confirmLabel={() => t('groupTriggers.pickConfirm')}
        onConfirm={(picked) => {
          const chosen = picked[0]
          setPicking(false)
          if (chosen !== undefined && draft !== null) setDraft({ ...draft, device: chosen.ref })
        }}
        onClose={() => setPicking(false)}
      />
    </CustomizeCard>
  )
}
