/**
 * D698 — the admin's per-section split of a state summary: the control, the
 * preview that shows the split, the body warning on a split rule, and the
 * TEST answer of a summary rule.
 */
import {
  type NcRuleInput,
  type NcStateSummaryPreview,
  type NcSystemEventDelivery,
  scheduleForSendTimes,
} from '@camstack/types'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@camstack/ui-library', async () => {
  const real = await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return {
    ...real,
    useSystem: () => ({
      trpcClient: { notificationRules: { previewStateSummary: { mutate: vi.fn() } } },
    }),
  }
})

import { SystemEventDeliveryField } from '../NotificationSystemEventDelivery'
import {
  buildRuleInput,
  emptyRuleForm,
  summaryTemplateWarning,
} from '../notification-rules.helpers'
import { parseRuleTestResult, summariseRuleTest } from '../notification-rule-test'
import { previewVerdictOf } from '../notification-system-event-delivery'

const EIGHT = scheduleForSendTimes([{ days: [1, 2, 3, 4, 5], minute: 480 }])
const SUMMARY: NcSystemEventDelivery = { mode: 'summary', schedule: EIGHT }
const SPLIT: NcSystemEventDelivery = { mode: 'summary', schedule: EIGHT, split: 'section' }

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

function form() {
  return {
    ...emptyRuleForm('system-event'),
    name: 'Stato',
    targetIds: ['t1'],
    conditions: { systemEvent: { kinds: ['device-battery-low' as const] } },
  }
}

const draft = (): NcRuleInput => buildRuleInput(form())

describe('the split control (D698)', () => {
  it('offers one message or one per category, absent = one message', () => {
    const onChange = vi.fn()
    wrap(
      <SystemEventDeliveryField
        value={SUMMARY}
        family="system"
        onChange={onChange}
        draft={draft}
      />,
    )
    expect(screen.getByRole('group', { name: 'How the summary is sent' })).toBeTruthy()
    expect(screen.getByTestId('rule-delivery-split-rule')).toBeChecked()
    fireEvent.click(screen.getByTestId('rule-delivery-split-section'))
    expect(onChange).toHaveBeenLastCalledWith(SPLIT)
  })

  it('editing a send time KEEPS the split', () => {
    const onChange = vi.fn()
    wrap(
      <SystemEventDeliveryField value={SPLIT} family="system" onChange={onChange} draft={draft} />,
    )
    expect(screen.getByTestId('rule-delivery-split-section')).toBeChecked()
    fireEvent.change(screen.getByTestId('schedule-field-time-0'), { target: { value: '21:30' } })
    expect(onChange).toHaveBeenLastCalledWith({
      mode: 'summary',
      schedule: { windows: [{ days: [1, 2, 3, 4, 5], startMinute: 1289, endMinute: 1290 }] },
      split: 'section',
    })
  })

  it('saves the split with the rule', () => {
    expect(buildRuleInput({ ...form(), systemEventDelivery: SPLIT }).systemEventDelivery).toEqual(
      SPLIT,
    )
  })
})

const SPLIT_PREVIEW: NcStateSummaryPreview = {
  empty: false,
  count: 2,
  text: 'Low batteries:\n• Termometro is down to 4% battery\nStreams offline:\n• Front door — stream offline',
  sections: [
    { id: 'battery', status: 'read', items: 1 },
    { id: 'streams', status: 'read', items: 1 },
  ],
  dropped: {},
  excludedGroups: [],
  split: 'section',
  rows: [
    {
      section: 'battery',
      title: 'Low batteries',
      text: '• Termometro is down to 4% battery',
      count: 1,
    },
    {
      section: 'streams',
      title: 'Streams offline',
      text: '• Front door — stream offline',
      count: 1,
    },
  ],
}

describe('the preview shows the split (D698)', () => {
  it('one block per notification, each under its category', () => {
    const lines = previewVerdictOf('success', SPLIT_PREVIEW, null, 'section')?.lines ?? []
    expect(lines[0]).toBe('2 notifications would be sent now, one per category:')
    expect(lines).toContain('Low batteries\n• Termometro is down to 4% battery')
    expect(lines).toContain('Streams offline\n• Front door — stream offline')
  })

  it('a hub that answers without the split is named as one that cannot split yet', () => {
    const { split: _split, rows: _rows, ...old } = SPLIT_PREVIEW
    const lines = previewVerdictOf('success', old, null, 'section')?.lines ?? []
    expect(lines.join('\n')).toMatch(/does not send per-category summaries yet/)
  })
})

describe('the body warning on a split rule (D698 review M3)', () => {
  it('a body naming one section only is completed on every other category', () => {
    const split = {
      ...form(),
      systemEventDelivery: SPLIT,
      templateBody: 'Oggi: {{summaryBattery}}',
    }
    expect(summaryTemplateWarning(split)).toMatch(/other categor/)
    expect(summaryTemplateWarning({ ...split, templateBody: '{{summaryText}}' })).toBeNull()
    expect(summaryTemplateWarning({ ...split, systemEventDelivery: SUMMARY })).toBeNull()
  })
})

describe('the TEST answer of a summary rule (D698)', () => {
  const base = {
    origin: 'synthetic',
    delivery: 'system-event',
    candidates: 1,
    still: 'unattachable',
    trigger: 'state-summary',
    planNotes: [],
  }

  it('says how many notifications were queued, per category', () => {
    const parsed = parseRuleTestResult({
      ...base,
      recordId: 'state-summary-test:r1:1',
      outcomes: [
        {
          ruleId: 'r1',
          ruleName: 'Stato',
          matched: true,
          cooldown: 'bypassed',
          enqueued: 2,
          targetIds: ['t1'],
        },
      ],
      notes: [],
      stateSummary: {
        recordId: 'state-summary-test:r1:1',
        split: 'section',
        nothingToReport: false,
        sections: [
          { id: 'battery', status: 'read', items: 2 },
          { id: 'streams', status: 'read', items: 1 },
        ],
        rows: [
          {
            recordId: 'state-summary-test:r1:1:battery',
            section: 'battery',
            enqueued: 1,
            targetIds: ['t1'],
          },
          {
            recordId: 'state-summary-test:r1:1:streams',
            section: 'streams',
            enqueued: 1,
            targetIds: ['t1'],
          },
        ],
      },
    })
    if (parsed === null) throw new Error('not parsed')
    expect(summariseRuleTest(parsed)).toBe(
      'Summary built now — 2 notifications queued (one per category: battery (2), streams (1)) to 1 target. They are marked [TEST] in the body.',
    )
  })

  it('nothing to report is said as such, never as a dropped event', () => {
    const parsed = parseRuleTestResult({
      ...base,
      recordId: 'state-summary-test:r1:1',
      outcomes: [
        {
          ruleId: 'r1',
          ruleName: 'Stato',
          matched: false,
          cooldown: 'bypassed',
          enqueued: 0,
          targetIds: [],
        },
      ],
      notes: [],
      droppedBy: 'nothing-to-report',
      stateSummary: {
        recordId: 'state-summary-test:r1:1',
        split: 'rule',
        nothingToReport: true,
        sections: [
          { id: 'battery', status: 'read', items: 0 },
          { id: 'streams', status: 'read', items: 0 },
        ],
        rows: [],
      },
    })
    if (parsed === null) throw new Error('not parsed')
    expect(summariseRuleTest(parsed)).toBe(
      'Nothing to report right now (battery: none open, streams: none open) — nothing was sent, exactly as the scheduled summary would send nothing.',
    )
  })
})
