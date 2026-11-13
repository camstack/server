/**
 * A group-window title says how many of which kind, never the rule's name.
 */
import { describe, expect, it } from 'vitest'
import { buildTemplateVars, renderRowTitle } from '../dispatcher.js'
import { groupWindowTitleChoice } from '../group-window-title.js'
import type { NcOutboxEntry } from '../outbox.js'
import { NcTextCatalog } from '../text-catalog.js'

function titled(language: 'en' | 'it', kinds: readonly string[], ruleName = 'Dispositivi'): string {
  const choice = groupWindowTitleChoice(kinds)
  if (choice === null) throw new Error('expected a titled burst')
  const texts = new NcTextCatalog({ language })
  const entry: NcOutboxEntry = {
    id: 's',
    ruleId: 'r',
    targetId: 't',
    deviceId: 0,
    recordKind: 'system-event',
    recordId: 'group-window',
    status: 'pending',
    attempts: 0,
    createdAt: 1,
    updatedAt: 1,
    nextAttemptAt: 1,
    payload: {
      ruleName,
      delivery: 'system-event',
      priority: 3,
      media: 'none',
      subject: {
        deviceId: 0,
        className: 'event',
        zones: [],
        timestamp: 1,
        systemEvent: {
          kind: 'device-online',
          subject: 'group',
          titleKey: choice.titleKey,
          textParams: {
            summaryCount: String(choice.count),
            offlineCount: String(choice.offlineCount),
            onlineCount: String(choice.onlineCount),
          },
          textCount: choice.count,
          data: { stateSummary: true },
        },
      },
    },
  }
  return renderRowTitle(texts, entry, buildTemplateVars(texts, entry, '', []))
}

describe('summary titles drop the rule name', () => {
  const italian = new NcTextCatalog({ language: 'it' })
  const english = new NcTextCatalog({ language: 'en' })

  it('a multi-camera digest, a state summary and a calendar are not named after the rule', () => {
    expect(
      italian.text({
        key: 'summary.title',
        vars: { from: '07:00', to: '09:00', rule: 'Notte' },
      }),
    ).toBe('Riepilogo 07:00→09:00')
    expect(
      english.text({
        key: 'system.state-summary.title',
        vars: { summarySection: 'Low batteries', summaryCount: '3', rule: 'Stato' },
      }),
    ).toBe('Low batteries: 3')
    expect(
      italian.text({
        key: 'calendar-events.title',
        vars: { count: '1', rule: 'Agenda' },
        count: 1,
      }),
    ).toBe('1 evento in arrivo')
    expect(
      english.text({
        key: 'calendar-events.title',
        vars: { count: '7', rule: 'Agenda' },
        count: 7,
      }),
    ).toBe('7 events upcoming')
  })
})

describe('group-window titles', () => {
  it('names devices coming back, devices offline, and a mix, in both languages', () => {
    expect(titled('it', ['device-online', 'device-online'])).toBe('2 dispositivi di nuovo online')
    expect(titled('it', ['device-online'])).toBe('1 dispositivo di nuovo online')
    expect(titled('en', ['device-offline', 'device-offline', 'device-offline'])).toBe(
      '3 devices offline',
    )
    expect(titled('it', ['device-offline', 'device-online', 'device-online'])).toBe(
      '1 offline, 2 di nuovo online',
    )
    expect(titled('en', ['device-offline', 'device-offline', 'device-online'])).toBe(
      '2 offline, 1 back online',
    )
  })

  it('names nodes and available updates, and leaves a mixed bag untitled by kind', () => {
    expect(titled('it', ['node-online', 'node-online'])).toBe('2 nodi di nuovo online')
    expect(titled('en', ['node-online'])).toBe('1 node back online')
    expect(titled('it', ['server-update-available', 'addon-update-available'])).toBe(
      '2 aggiornamenti disponibili',
    )
    expect(titled('en', ['wrapper-update-available'])).toBe('1 update available')
    expect(groupWindowTitleChoice(['device-online', 'node-offline'])).toBeNull()
  })

  it('an operator title still wins', () => {
    const texts = new NcTextCatalog({ language: 'it' })
    const choice = groupWindowTitleChoice(['device-online', 'device-online'])
    if (choice === null) throw new Error('expected a titled burst')
    const entry: NcOutboxEntry = {
      id: 's',
      ruleId: 'r',
      targetId: 't',
      deviceId: 0,
      recordKind: 'system-event',
      recordId: 'group-window',
      status: 'pending',
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
      nextAttemptAt: 1,
      payload: {
        ruleName: 'Dispositivi',
        delivery: 'system-event',
        priority: 3,
        media: 'none',
        template: { title: '{{rule}}: {{summaryCount}}' },
        subject: {
          deviceId: 0,
          className: 'event',
          zones: [],
          timestamp: 1,
          systemEvent: {
            kind: 'device-online',
            subject: 'group',
            titleKey: choice.titleKey,
            textParams: { summaryCount: '2' },
            textCount: 2,
            data: {},
          },
        },
      },
    }
    expect(renderRowTitle(texts, entry, buildTemplateVars(texts, entry, '', []))).toBe(
      'Dispositivi: 2',
    )
  })
})
