/**
 * D647 / D1019 — the admin's Delivery control on device-events / system rules:
 * starts / clears / schedule, "send at HH:MM on days …" stored as a window
 * that ENDS at that minute, and the form that saves it.
 */
import {
  type NcRuleInput,
  type NcStateSummaryPreview,
  type NcSystemEventDelivery,
  type NcSystemEventKind,
  scheduleForSendTimes,
} from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockPreview = vi.fn(
  (_input: { rule: NcRuleInput }): Promise<NcStateSummaryPreview> =>
    Promise.resolve({
      empty: false,
      count: 1,
      text: 'Low batteries:\n• Termometro is down to 4% battery',
      sections: [{ id: 'battery', status: 'read', items: 1 }],
      dropped: { muted: 1 },
      excludedGroups: [],
    }),
)

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: { notificationRules: { previewStateSummary: { mutate: mockPreview } } },
    }),
  }
})

import { SystemEventDeliveryField } from '../NotificationSystemEventDelivery'
import {
  buildRuleClears,
  buildRuleInput,
  emptyRuleForm,
  isRuleFormValid,
  isStateSummaryForm,
  ruleFormProblems,
  summaryTemplateWarning,
} from '../notification-rules.helpers'
import { NEW_SYSTEM_EVENT_DELIVERY, previewVerdictOf } from '../notification-system-event-delivery'

const EIGHT = scheduleForSendTimes([{ days: [1, 2, 3, 4, 5], minute: 480 }])
const SUMMARY: NcSystemEventDelivery = { mode: 'summary', schedule: EIGHT }

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

function batteryForm() {
  const form = emptyRuleForm('system-event')
  return {
    ...form,
    name: 'Stato',
    targetIds: ['t1'],
    conditions: { systemEvent: { kinds: ['device-battery-low' as const] } },
  }
}

const MODES_SCHEDULE_ONLY: NcSystemEventDelivery = {
  mode: 'modes',
  onActivation: false,
  onDeactivation: false,
  onSchedule: { schedule: EIGHT, grouping: 'rule' },
}

function field(
  value: NcSystemEventDelivery | undefined,
  onChange: (next: NcSystemEventDelivery) => void = () => {},
  kinds: readonly NcSystemEventKind[] = ['device-battery-low'],
  family: 'device-events' | 'system' | 'alarm' = 'device-events',
) {
  return wrap(
    <SystemEventDeliveryField
      value={value}
      family={family}
      kinds={kinds}
      onChange={onChange}
      draft={() => buildRuleInput(batteryForm())}
    />,
  )
}

describe('SystemEventDeliveryField', () => {
  it('is not offered on an alarm rule — the alarm stays instant', () => {
    const { container } = field(undefined, () => {}, ['alarm-armed'], 'alarm')
    expect(container.innerHTML).toBe('')
  })

  it('a new rule starts on "when it starts" alone; each toggle writes the modes shape', () => {
    const onChange = vi.fn()
    field(NEW_SYSTEM_EVENT_DELIVERY, onChange)
    expect(screen.getByTestId('rule-delivery-activation')).toBeChecked()
    expect(screen.getByTestId('rule-delivery-deactivation')).not.toBeChecked()
    expect(screen.getByTestId('rule-delivery-schedule')).not.toBeChecked()
    fireEvent.click(screen.getByTestId('rule-delivery-deactivation'))
    expect(onChange).toHaveBeenLastCalledWith({
      mode: 'modes',
      onActivation: true,
      onDeactivation: true,
    })
    fireEvent.click(screen.getByTestId('rule-delivery-schedule'))
    expect(onChange).toHaveBeenLastCalledWith({
      mode: 'modes',
      onActivation: true,
      onDeactivation: false,
      // Newly enabled: every day at 08:00, one notification per category.
      onSchedule: {
        schedule: { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 479, endMinute: 480 }] },
        grouping: 'section',
      },
    })
  })

  it('a legacy instant rule opens with both edges where its kinds have a recovery', () => {
    field({ mode: 'instant' }, () => {}, ['device-offline'])
    expect(screen.getByTestId('rule-delivery-activation')).toBeChecked()
    expect(screen.getByTestId('rule-delivery-deactivation')).toBeChecked()
  })

  it('"send at" edits the END of the window and the toggle off drops the schedule', () => {
    const onChange = vi.fn()
    field(MODES_SCHEDULE_ONLY, onChange)
    fireEvent.change(screen.getByTestId('schedule-field-time-0'), { target: { value: '21:30' } })
    expect(onChange).toHaveBeenLastCalledWith({
      ...MODES_SCHEDULE_ONLY,
      onSchedule: {
        schedule: { windows: [{ days: [1, 2, 3, 4, 5], startMinute: 1289, endMinute: 1290 }] },
        grouping: 'rule',
      },
    })
    fireEvent.click(screen.getByTestId('rule-delivery-schedule'))
    expect(onChange).toHaveBeenLastCalledWith({
      mode: 'modes',
      onActivation: false,
      onDeactivation: false,
    })
  })

  it('a longer window is shown as a punctual send-at (window END), not two clocks', () => {
    field({
      mode: 'modes',
      onActivation: false,
      onDeactivation: false,
      onSchedule: {
        schedule: { windows: [{ days: [1], startMinute: 0, endMinute: 480 }] },
        grouping: 'rule',
      },
    })
    expect(screen.getByTestId('schedule-field-times-approximated')).toHaveTextContent(
      "window's end",
    )
    expect((screen.getByTestId('schedule-field-time-0') as HTMLInputElement).value).toBe('08:00')
  })

  it('says what "when it clears" adds and which kinds have no clearing event', () => {
    field(
      { mode: 'modes', onActivation: true, onDeactivation: true },
      () => {},
      ['device-offline', 'backup-completed'],
      'device-events',
    )
    expect(screen.getByTestId('rule-delivery-clears-hint')).toHaveTextContent('Device connectivity')
    expect(screen.getByTestId('rule-delivery-no-clearing-hint')).toHaveTextContent(
      '1 selected event has no clearing event',
    )
  })

  it('says active hours and actions do not apply when the schedule is the only mode', () => {
    field(MODES_SCHEDULE_ONLY)
    expect(screen.getByTestId('rule-delivery-schedule-hint')).toHaveTextContent(
      'active hours and actions of this rule do not apply',
    )
  })

  it('shows what the validator refuses, inline', () => {
    field({ mode: 'modes', onActivation: false, onDeactivation: false })
    expect(screen.getByTestId('rule-delivery-problem')).toHaveTextContent(
      'choose when the rule speaks',
    )
  })

  it('refuses deactivation alone when no selected kind ever clears', () => {
    field(
      { mode: 'modes', onActivation: false, onDeactivation: true },
      () => {},
      ['backup-completed'],
      'system',
    )
    expect(screen.getByTestId('rule-delivery-problem')).toHaveTextContent('ever clears')
  })

  it('previews the draft as the hub would send it now', async () => {
    field(MODES_SCHEDULE_ONLY)
    fireEvent.click(screen.getByTestId('rule-delivery-preview'))
    await waitFor(() =>
      expect(screen.getByTestId('rule-delivery-preview-result')).toHaveTextContent('Termometro'),
    )
    expect(mockPreview.mock.calls[0]?.[0].rule.conditions.systemEvent?.kinds).toEqual([
      'device-battery-low',
    ])
  })
})

describe('previewVerdictOf — a failed preview is never "nothing to report" (D315)', () => {
  it('names an old hub as old', () => {
    expect(previewVerdictOf('error', undefined, { data: { code: 'NOT_FOUND' } })?.lines[0]).toMatch(
      /does not serve summary rules yet/,
    )
  })
  it('says an empty state sends nothing', () => {
    expect(
      previewVerdictOf(
        'success',
        {
          empty: true,
          count: 0,
          text: '',
          sections: [],
          dropped: {},
          excludedGroups: ['backups-exports'],
        },
        null,
      )?.lines,
    ).toEqual([
      'Nothing to report right now — no notification would be sent.',
      'Backups and exports are completed jobs, not a state — they are not in a summary.',
    ])
  })
})

describe('the rule form saves the delivery (D1019)', () => {
  it('a NEW system rule WRITES the key: starts on, clears off, no schedule', () => {
    const form = {
      ...emptyRuleForm('system-event'),
      name: 'Stato',
      targetIds: ['t1'],
      conditions: { systemEvent: { kinds: ['device-offline' as const] } },
    }
    expect(buildRuleInput(form).systemEventDelivery).toEqual({
      mode: 'modes',
      onActivation: true,
      onDeactivation: false,
    })
  })

  it('a new ALARM rule never carries the key', () => {
    const form = {
      ...emptyRuleForm('system-event'),
      name: 'Allarme',
      targetIds: ['t1'],
      conditions: { systemEvent: { kinds: ['alarm-armed' as const] } },
    }
    expect(buildRuleInput(form)).not.toHaveProperty('systemEventDelivery')
  })

  it('a rule loaded as schedule-only modes opens with the schedule on and saves the SAME object back', () => {
    const form = { ...batteryForm(), systemEventDelivery: MODES_SCHEDULE_ONLY }
    field(MODES_SCHEDULE_ONLY)
    expect(screen.getByTestId('rule-delivery-schedule')).toBeChecked()
    expect(screen.getByTestId('rule-delivery-activation')).not.toBeChecked()
    expect(isStateSummaryForm(form)).toBe(true)
    expect(buildRuleInput(form).systemEventDelivery).toBe(MODES_SCHEDULE_ONLY)
    expect(buildRuleInput(form).schedule).toBeUndefined()
    expect(buildRuleClears(form, [])).toContain('schedule')
    expect(isRuleFormValid(form)).toBe(true)
  })

  it('a rule that also speaks per event keeps its active-hours schedule', () => {
    const mixed: NcSystemEventDelivery = { ...MODES_SCHEDULE_ONLY, onActivation: true }
    const hours = { windows: [{ days: [1], startMinute: 0, endMinute: 600 }] }
    const form = { ...batteryForm(), systemEventDelivery: mixed, schedule: hours }
    expect(isStateSummaryForm(form)).toBe(false)
    expect(buildRuleInput(form).schedule).toEqual(hours)
    expect(buildRuleInput(form).systemEventDelivery).toBe(mixed)
  })

  it('a legacy summary value still saves as stored', () => {
    const form = { ...batteryForm(), systemEventDelivery: SUMMARY }
    expect(buildRuleInput(form).systemEventDelivery).toEqual(SUMMARY)
    expect(isStateSummaryForm(form)).toBe(true)
  })

  it('an all-off delivery is a blocker, in words', () => {
    const form = {
      ...batteryForm(),
      systemEventDelivery: { mode: 'modes' as const, onActivation: false, onDeactivation: false },
    }
    expect(ruleFormProblems(form).join(' ')).toMatch(/choose when the rule speaks/)
    expect(isRuleFormValid(form)).toBe(false)
  })

  it('a schedule-only rule with actions is a blocker, in words', () => {
    const form = {
      ...batteryForm(),
      systemEventDelivery: MODES_SCHEDULE_ONLY,
      actions: {
        onActivation: [],
        onDeactivation: [],
        onTrigger: ['internal:x'],
        onTriggerOff: [],
        buttons: [],
      },
    }
    expect(ruleFormProblems(form).join(' ')).toMatch(/actions would never run/)
    expect(isRuleFormValid(form)).toBe(false)
  })
})

describe('review M3/M4 — the admin save of a summary rule', () => {
  it('warns when the custom body names none of the summary, and not otherwise', () => {
    const summary = { ...batteryForm(), systemEventDelivery: SUMMARY }
    expect(summaryTemplateWarning({ ...summary, templateBody: 'Buongiorno' })).toMatch(/appends/)
    expect(
      summaryTemplateWarning({ ...summary, templateBody: 'Oggi: {{summaryBattery}}' }),
    ).toBeNull()
    expect(summaryTemplateWarning({ ...summary, templateBody: '' })).toBeNull()
    expect(summaryTemplateWarning({ ...batteryForm(), templateBody: 'Buongiorno' })).toBeNull()
  })

  it('a former summary rule moved to another trigger sends { mode: instant } so the hub does not refuse it', () => {
    const moved = {
      ...batteryForm(),
      delivery: 'immediate' as const,
      conditions: {},
      systemEventDelivery: SUMMARY,
    }
    expect(buildRuleInput(moved).systemEventDelivery).toEqual({ mode: 'instant' })
    // A rule that never was a summary writes nothing.
    expect(buildRuleInput({ ...moved, systemEventDelivery: undefined })).not.toHaveProperty(
      'systemEventDelivery',
    )
  })
})
