/**
 * The scheduler editor: scheduler-level settings, profile tabs (days per
 * profile), a 24 h timeline with draggable points, the selected point's
 * editor, and the Runs ledger. The draft leaves only through
 * `checkSchedulerDraft`, the same parse and author-time rules the hub applies.
 */
import type { Scheduler, SchedulerInput, SchedulerPoint, WeekdayKey } from '@camstack/types'
import {
  Badge,
  Button,
  ErrorBox,
  Input,
  SectionCard,
  SettingRow,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TimelineSlider,
  type TimelineMarker,
  useConfirm,
  useSchedulersConflicts,
  useSchedulersCreate,
  useSchedulersDelete,
  useSchedulersGetTraces,
  useSchedulersUpdate,
  useSystemGetSiteLocation,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Loader2, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAutomationDevices } from '../automation/automation-data'
import { DraftNumberInput } from '../flow/DraftNumberInput'
import { RunsPanel } from '../flow/RunsPanel'
import { ActiveWhenField } from './ActiveWhenField'
import { PointEditor } from './PointEditor'
import {
  ALL_WEEKDAYS,
  checkSchedulerDraft,
  clockText,
  emptyProfile,
  emptySchedulerDraft,
  holdBands,
  minuteText,
  newPoint,
  nextId,
  pointMinute,
  type SiteView,
  sunBaseMinute,
  timeSpecAfterDrag,
  todayAt,
} from './scheduler-model'

const POLL_MS = 5_000
const DEBOUNCE_MS = 600
const MINUTE_MS = 60_000
const DEFAULT_SITE: SiteView = { timeZone: 'UTC', location: null }

export interface SchedulerEditorProps {
  /** `null` while creating. */
  readonly entry: Scheduler | null
  readonly onClose: () => void
  readonly onSaved: (schedulerId: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inputOf(entry: Scheduler | null): SchedulerInput {
  if (entry === null) return emptySchedulerDraft()
  const { id: _id, createdAt: _c, updatedAt: _u, ...input } = entry
  return input
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

function dayLabel(day: WeekdayKey, t: (key: string, fallback: string) => string): string {
  return t(`schedulers.day.${day}`, day)
}

export function SchedulerEditor({ entry, onClose, onSaved }: SchedulerEditorProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const devices = useAutomationDevices()
  const siteQuery = useSystemGetSiteLocation()
  const site: SiteView = siteQuery.data ?? DEFAULT_SITE
  const [draft, setDraft] = useState<SchedulerInput>(() => inputOf(entry))
  const [profileId, setProfileId] = useState<string>(() => draft.profiles[0]?.id ?? '')
  const [pointId, setPointId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: [['schedulers']] })
  }
  const create = useSchedulersCreate({
    onSuccess: (result) => {
      refresh()
      onSaved(result.scheduler.id)
    },
  })
  const update = useSchedulersUpdate({ onSuccess: refresh })
  const remove = useSchedulersDelete({
    onSuccess: () => {
      refresh()
      onClose()
    },
  })
  const traces = useSchedulersGetTraces(
    { schedulerId: entry?.id ?? 'none' },
    { enabled: entry !== null, refetchInterval: POLL_MS },
  )

  const check = useMemo(() => checkSchedulerDraft(draft, site), [draft, site])
  const hasHold = draft.profiles.some((p) => p.points.some((point) => point.mode === 'hold'))
  const settled = useDebounced(check.ok ? check.input : null, DEBOUNCE_MS)
  const conflicts = useSchedulersConflicts(
    settled === null
      ? { scheduler: draft }
      : entry === null
        ? { scheduler: settled }
        : { scheduler: settled, schedulerId: entry.id },
    { enabled: settled !== null && hasHold && siteQuery.data !== undefined },
  )

  const profile = draft.profiles.find((p) => p.id === profileId) ?? draft.profiles[0]
  const profileIndex = profile === undefined ? -1 : draft.profiles.indexOf(profile)
  const localDate = todayAt(site)
  const point = profile?.points.find((candidate) => candidate.id === pointId) ?? null
  const pointIndex = profile === undefined || point === null ? -1 : profile.points.indexOf(point)
  const issues = check.ok ? [] : check.issues
  const issuesAt = (prefix: string) =>
    issues.filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`))

  const setProfile = (next: SchedulerInput['profiles'][number]): void =>
    setDraft({
      ...draft,
      profiles: draft.profiles.map((p, index) => (index === profileIndex ? next : p)),
    })
  const setPoint = (next: SchedulerPoint): void => {
    if (profile === undefined) return
    setProfile({
      ...profile,
      points: profile.points.map((p) => (p.id === next.id ? next : p)),
    })
  }

  const markers: readonly TimelineMarker[] = useMemo(() => {
    if (profile === undefined) return []
    return profile.points.flatMap((p): TimelineMarker[] => {
      const minute = pointMinute(p.at, site, localDate)
      if (minute === null) return []
      const label =
        p.at.kind === 'sun'
          ? `${t(`schedulers.sun.${p.at.event}`, p.at.event)} ${p.at.offsetMin >= 0 ? '+' : ''}${String(p.at.offsetMin)} (${minuteText(minute)})`
          : clockText(p.at.hh, p.at.mm)
      return [
        {
          id: p.id,
          minute,
          label,
          tone: p.mode === 'hold' ? 'success' : p.mode === 'release' ? 'neutral' : 'primary',
          draggable:
            p.at.kind === 'clock' ||
            (p.at.kind === 'sun' && sunBaseMinute(p.at, site, localDate) !== null),
        },
      ]
    })
  }, [profile, site, localDate, t])
  const bands = useMemo(
    () => (profile === undefined ? [] : holdBands(profile.points, site, localDate)),
    [profile, site, localDate],
  )

  const onMove = (id: string, minute: number): void => {
    const target = profile?.points.find((p) => p.id === id)
    if (target === undefined) return
    setPoint({
      ...target,
      at: timeSpecAfterDrag(target.at, minute, sunBaseMinute(target.at, site, localDate)),
    })
  }

  const addPoint = (mode: SchedulerPoint['mode']): void => {
    if (profile === undefined) return
    const id = nextId(
      'point',
      draft.profiles.flatMap((p) => p.points.map((q) => q.id)),
    )
    setProfile({
      ...profile,
      points: [...profile.points, newPoint(mode, id, 12 * 60)],
    })
    setPointId(id)
  }

  const addProfile = (): void => {
    const id = nextId(
      'profile',
      draft.profiles.map((p) => p.id),
    )
    setDraft({
      ...draft,
      profiles: [
        ...draft.profiles,
        emptyProfile(id, t('schedulers.profile.newName', 'New profile')),
      ],
    })
    setProfileId(id)
    setPointId(null)
  }

  const saving = create.isPending || update.isPending
  const saveError = create.error ?? update.error ?? remove.error
  const save = (): void => {
    if (!check.ok) return
    if (entry === null) create.mutate({ scheduler: check.input })
    else update.mutate({ schedulerId: entry.id, scheduler: check.input })
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]" data-testid="scheduler-editor">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <CalendarClock className="h-4 w-4 text-foreground-muted" />
          <Input
            aria-label={t('schedulers.editor.name', 'Name')}
            className="max-w-xs flex-1"
            value={draft.name}
            placeholder={t('schedulers.editor.namePlaceholder', 'What this scheduler does')}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>

        <SectionCard
          headingId="scheduler-settings"
          title={t('schedulers.editor.settings', 'Settings')}
        >
          <div className="divide-y divide-border px-3">
            <SettingRow label={t('schedulers.editor.enabled', 'Enabled')}>
              <Switch
                checked={draft.enabled}
                aria-label={t('schedulers.editor.enabled', 'Enabled')}
                onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
              />
            </SettingRow>
            <SettingRow
              label={t('schedulers.editor.priority', 'Priority (higher wins a conflict)')}
            >
              <DraftNumberInput
                aria-label={t('schedulers.editor.priority', 'Priority (higher wins a conflict)')}
                className="w-24"
                value={draft.priority}
                onValue={(value) => {
                  if (value !== null) setDraft({ ...draft, priority: Math.round(value) })
                }}
              />
            </SettingRow>
            <SettingRow
              label={t('schedulers.editor.maxLate', 'Run a missed point up to (minutes late)')}
            >
              <DraftNumberInput
                aria-label={t(
                  'schedulers.editor.maxLate',
                  'Run a missed point up to (minutes late)',
                )}
                className="w-24"
                value={draft.maxLateMs / MINUTE_MS}
                onValue={(value) => {
                  if (value !== null)
                    setDraft({
                      ...draft,
                      maxLateMs: Math.round(value * MINUTE_MS),
                    })
                }}
              />
            </SettingRow>
          </div>
          <div className="p-3">
            <ActiveWhenField
              value={draft.activeWhen}
              devices={devices}
              label={t('schedulers.editor.activeWhen', 'Only when a condition holds')}
              onChange={(activeWhen) => {
                const { activeWhen: _drop, ...rest } = draft
                setDraft(activeWhen === undefined ? rest : { ...rest, activeWhen })
              }}
            />
            {issuesAt('activeWhen').map((issue) => (
              <p key={issue.message} className="mt-1 text-xs text-warning">
                {issue.message}
              </p>
            ))}
          </div>
        </SectionCard>

        <SectionCard
          headingId="scheduler-profiles"
          title={t('schedulers.editor.profiles', 'Profiles')}
          actions={
            <Button variant="outline" size="sm" onClick={addProfile}>
              <Plus className="h-4 w-4" /> {t('schedulers.profile.add', 'Add profile')}
            </Button>
          }
        >
          <div className="space-y-3 p-3">
            <p className="text-xs text-foreground-subtle">
              {t(
                'schedulers.profile.hint',
                'Each day, the first profile in this order whose days and condition hold is the one that runs.',
              )}
            </p>
            {profile !== undefined && (
              <Tabs
                value={profile.id}
                onValueChange={(id) => {
                  setProfileId(id)
                  setPointId(null)
                }}
                appearance="pills"
              >
                <TabsList>
                  {draft.profiles.map((p) => (
                    <TabsTrigger key={p.id} value={p.id}>
                      {p.name}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value={profile.id} className="space-y-3 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label={t('schedulers.profile.name', 'Profile name')}
                      className="max-w-xs"
                      value={profile.name}
                      onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                    />
                    <Switch
                      checked={profile.enabled}
                      label={t('schedulers.profile.enabled', 'Enabled')}
                      onCheckedChange={(enabled) => setProfile({ ...profile, enabled })}
                    />
                    {draft.profiles.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setDraft({
                            ...draft,
                            profiles: draft.profiles.filter((p) => p.id !== profile.id),
                          })
                          setProfileId('')
                          setPointId(null)
                        }}
                      >
                        <Trash2 className="h-4 w-4" />{' '}
                        {t('schedulers.profile.remove', 'Remove profile')}
                      </Button>
                    )}
                  </div>
                  <div
                    className="flex flex-wrap gap-1"
                    role="group"
                    aria-label={t('schedulers.profile.days', 'Days')}
                  >
                    {ALL_WEEKDAYS.map((day) => {
                      const on = profile.days.includes(day)
                      return (
                        <Button
                          key={day}
                          size="sm"
                          variant={on ? 'primary' : 'outline'}
                          aria-pressed={on}
                          onClick={() =>
                            setProfile({
                              ...profile,
                              days: on
                                ? profile.days.filter((d) => d !== day)
                                : ALL_WEEKDAYS.filter((d) => d === day || profile.days.includes(d)),
                            })
                          }
                        >
                          {dayLabel(day, t)}
                        </Button>
                      )
                    })}
                  </div>
                  {issuesAt(`profiles.${String(profileIndex)}.days`).map((issue) => (
                    <p key={issue.message} className="text-xs text-warning">
                      {t('schedulers.profile.daysNeeded', 'Pick at least one day.')}
                    </p>
                  ))}
                  <ActiveWhenField
                    value={profile.activeWhen}
                    devices={devices}
                    label={t(
                      'schedulers.profile.activeWhen',
                      'This profile only when a condition holds',
                    )}
                    onChange={(activeWhen) => {
                      const { activeWhen: _drop, ...rest } = profile
                      setProfile(activeWhen === undefined ? rest : { ...rest, activeWhen })
                    }}
                  />
                  <TimelineSlider
                    ariaLabel={t('schedulers.timeline.label', 'Day timeline')}
                    markers={markers}
                    bands={bands}
                    selectedId={pointId}
                    onSelect={setPointId}
                    onMove={onMove}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => addPoint('edge')}>
                      <Plus className="h-4 w-4" /> {t('schedulers.point.addEdge', 'Edge')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => addPoint('hold')}>
                      <Plus className="h-4 w-4" /> {t('schedulers.point.addHold', 'Hold')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => addPoint('release')}>
                      <Plus className="h-4 w-4" /> {t('schedulers.point.addRelease', 'Release')}
                    </Button>
                    <Badge variant="neutral">{site.timeZone}</Badge>
                  </div>
                  {profile.points.length === 0 && (
                    <p className="text-xs text-foreground-subtle">
                      {t('schedulers.timeline.empty', 'Add a point to place something on the day.')}
                    </p>
                  )}
                  {point !== null && (
                    <PointEditor
                      key={point.id}
                      point={point}
                      devices={devices}
                      site={site}
                      localDate={localDate}
                      issues={issuesAt(
                        `profiles.${String(profileIndex)}.points.${String(pointIndex)}`,
                      )}
                      onChange={setPoint}
                      onRemove={() => {
                        setProfile({
                          ...profile,
                          points: profile.points.filter((p) => p.id !== point.id),
                        })
                        setPointId(null)
                      }}
                    />
                  )}
                </TabsContent>
              </Tabs>
            )}
          </div>
        </SectionCard>

        {conflicts.data !== undefined && conflicts.data.conflicts.length > 0 && (
          <ul className="space-y-1 rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            {conflicts.data.conflicts.map((c) => (
              <li
                key={`${c.other.schedulerId}:${c.other.pointId}:${c.mine.pointId}:${String(c.deviceId)}`}
              >
                {t(
                  'schedulers.conflict.message',
                  '{{other}} wants device {{device}} in another state from {{from}} to {{to}} ({{winner}}).',
                  {
                    other: c.other.schedulerName,
                    device: c.deviceId,
                    from: minuteText(c.fromMinute),
                    to: minuteText(c.toMinute),
                    winner:
                      c.winner === 'mine'
                        ? t('schedulers.conflict.mine', 'this one wins')
                        : c.winner === 'other'
                          ? t('schedulers.conflict.other', 'the other one wins')
                          : t('schedulers.conflict.tie', 'the one that started first wins'),
                  },
                )}
              </li>
            ))}
          </ul>
        )}
        {!check.ok && draft.name !== '' && issues.length > 0 && point === null && (
          <ul className="space-y-1 rounded border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        )}
        {saveError !== null && <ErrorBox message={errorMessage(saveError)} />}

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={saving || !check.ok || siteQuery.data === undefined}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} {t('common.save', 'Save')}
          </Button>
          {entry !== null && (
            <Button
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => {
                void confirm({
                  title: t('schedulers.editor.deleteTitle', 'Delete this scheduler?'),
                  message: t(
                    'schedulers.editor.deleteMessage',
                    '{{name}} will be deleted and any hold it keeps will stop.',
                    { name: entry.name },
                  ),
                  confirmLabel: t('common.delete', 'Delete'),
                  variant: 'danger',
                }).then((accepted) => {
                  if (accepted) remove.mutate({ schedulerId: entry.id })
                })
              }}
            >
              <Trash2 className="h-4 w-4" /> {t('common.delete', 'Delete')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('common.close', 'Close')}
          </Button>
        </div>
      </div>
      <div className="order-first lg:order-last">
        <RunsPanel
          traces={entry === null ? [] : traces.data?.traces}
          selectedId={runId}
          onSelect={setRunId}
        />
      </div>
    </div>
  )
}
