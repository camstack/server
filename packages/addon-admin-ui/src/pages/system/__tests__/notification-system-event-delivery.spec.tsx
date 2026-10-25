/**
 * D647 — the admin's Delivery control on device-events / system rules:
 * Instant | Summary on schedule, "send at HH:MM on days …" stored as a window
 * that ENDS at that minute, and the form that saves it.
 */
import {
  type NcRuleInput,
  type NcStateSummaryPreview,
  type NcSystemEventDelivery,
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
  ruleFormProblems,
  summaryTemplateWarning,
} from '../notification-rules.helpers'
import { previewVerdictOf } from '../notification-system-event-delivery'

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

describe('SystemEventDeliveryField', () => {
  const draft = (): NcRuleInput => buildRuleInput(batteryForm())

  it('is not offered on an alarm rule — the alarm stays instant', () => {
    const { container } = wrap(
      <SystemEventDeliveryField
        value={undefined}
        family="alarm"
        onChange={() => {}}
        draft={draft}
      />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('switching to Summary on schedule starts at "every day at 08:00" — a window ending at 08:00', () => {
    const onChange = vi.fn()
    wrap(
      <SystemEventDeliveryField
        value={undefined}
        family="device-events"
        onChange={onChange}
        draft={draft}
      />,
    )
    expect(screen.getByTestId('rule-delivery-instant')).toBeChecked()
    fireEvent.click(screen.getByTestId('rule-delivery-summary'))
    expect(onChange).toHaveBeenCalledWith({
      mode: 'summary',
      schedule: { windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 479, endMinute: 480 }] },
    })
  })

  it('"send at" edits the END of the window, and Instant goes back explicitly', () => {
    const onChange = vi.fn()
    wrap(
      <SystemEventDeliveryField
        value={SUMMARY}
        family="system"
        onChange={onChange}
        draft={draft}
      />,
    )
    fireEvent.change(screen.getByTestId('schedule-field-time-0'), { target: { value: '21:30' } })
    expect(onChange).toHaveBeenLastCalledWith({
      mode: 'summary',
      schedule: { windows: [{ days: [1, 2, 3, 4, 5], startMinute: 1289, endMinute: 1290 }] },
    })
    fireEvent.click(screen.getByTestId('rule-delivery-instant'))
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'instant' })
  })

  it('a longer window is shown as a punctual send-at (window END), not two clocks', () => {
    const custom: NcSystemEventDelivery = {
      mode: 'summary',
      schedule: { windows: [{ days: [1], startMinute: 0, endMinute: 480 }] },
    }
    wrap(
      <SystemEventDeliveryField value={custom} family="system" onChange={() => {}} draft={draft} />,
    )
    expect(screen.getByTestId('schedule-field-times')).toBeTruthy()
    expect(screen.getByTestId('schedule-field-times-approximated')).toHaveTextContent(
      "window's end",
    )
    // 480 = 08:00 — one clock, not a start→end pair.
    expect((screen.getByTestId('schedule-field-time-0') as HTMLInputElement).value).toBe('08:00')
  })

  it('previews the draft as the hub would send it now', async () => {
    wrap(
      <SystemEventDeliveryField
        value={SUMMARY}
        family="device-events"
        onChange={() => {}}
        draft={draft}
      />,
    )
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

describe('the rule form saves a summary', () => {
  it('emits the delivery, drops the active-hours schedule, and CLEARS a stored one', () => {
    const form = {
      ...batteryForm(),
      systemEventDelivery: SUMMARY,
      schedule: { windows: [{ days: [1], startMinute: 0, endMinute: 600 }] },
    }
    const input = buildRuleInput(form)
    expect(input.systemEventDelivery).toEqual(SUMMARY)
    expect(input.schedule).toBeUndefined()
    expect(buildRuleClears(form, [])).toContain('schedule')
    expect(isRuleFormValid(form)).toBe(true)
  })

  it('an instant rule never writes the field — unless it is going back from a summary', () => {
    expect(buildRuleInput(batteryForm())).not.toHaveProperty('systemEventDelivery')
    expect(
      buildRuleInput({ ...batteryForm(), systemEventDelivery: { mode: 'instant' } })
        .systemEventDelivery,
    ).toEqual({ mode: 'instant' })
  })

  it('a summary with actions is a blocker, in words', () => {
    const form = {
      ...batteryForm(),
      systemEventDelivery: SUMMARY,
      actions: {
        onActivation: [],
        onDeactivation: [],
        onTrigger: [{ kind: 'do' as const, action: { kind: 'wait' as const, seconds: 1 } }],
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
