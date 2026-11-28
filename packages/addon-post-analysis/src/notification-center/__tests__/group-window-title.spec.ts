/**
 * A group-window title says how many of which kind, never the rule's name.
 */
import { NcRuleInputSchema, NcRuleSchema, type NcSystemEventKind } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { buildTemplateVars, renderRowTitle } from '../dispatcher.js'
import { groupWindowSubject } from '../group-window-summary.js'
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

function burstRow(kind: NcSystemEventKind, index: number, ruleName: string): NcOutboxEntry {
  return {
    id: `r:${kind}:${String(index)}`,
    ruleId: 'r',
    targetId: 't',
    deviceId: index + 1,
    recordKind: 'system-event',
    recordId: `ev-${kind}-${String(index)}`,
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
        deviceId: index + 1,
        className: 'event',
        zones: [],
        timestamp: 1,
        systemEvent: {
          kind,
          subject: `${kind}:${String(index)}`,
          bodyKey: `system.${kind}.body`,
          deviceId: index + 1,
          textParams: {
            deviceName: `Device ${String(index)}`,
            message: 'installer failed',
            percentage: '0',
            item: 'Filter',
            title: 'Installer',
            packageName: '@dominevo/addon-post-analysis',
            currentVersion: '1',
            latestVersion: '2',
          },
          data: {},
        },
      },
    },
  }
}

/** The title a burst is sent with, through the same subject the window builds. */
function windowTitle(
  language: 'en' | 'it',
  kinds: readonly NcSystemEventKind[],
  templateTitle?: string,
  ruleName = 'Dispositivi',
): string {
  const texts = new NcTextCatalog({ language })
  const rule = NcRuleSchema.parse({
    ...NcRuleInputSchema.parse({
      name: ruleName,
      delivery: 'system-event',
      conditions: { systemEvent: { kinds: [...new Set(kinds)] } },
      targets: [{ targetId: 't' }],
    }),
    id: 'r',
    createdBy: 'admin',
    createdAt: 1,
    updatedAt: 1,
  })
  const subject = groupWindowSubject({
    rule,
    entries: kinds.map((kind, index) => burstRow(kind, index, ruleName)),
    texts,
    nowMs: 2_000,
    openedAt: 1_000,
    targetId: 't',
  })
  const systemEvent = subject?.systemEvent
  if (systemEvent === undefined) throw new Error('expected a group-window subject')
  const entry: NcOutboxEntry = {
    ...burstRow(kinds[0] ?? 'device-online', 0, ruleName),
    id: 'summary',
    payload: {
      ruleName,
      delivery: 'system-event',
      priority: 3,
      media: 'none',
      ...(templateTitle !== undefined ? { template: { title: templateTitle } } : {}),
      subject: {
        deviceId: 0,
        className: 'event',
        zones: [],
        timestamp: 1,
        systemEvent,
      },
    },
  }
  return renderRowTitle(texts, entry, buildTemplateVars(texts, entry, '', []))
}

describe('a one-kind burst is titled with what happened', () => {
  it('a recovery of 43 devices is back online, never the offline section', () => {
    const kinds: NcSystemEventKind[] = Array.from({ length: 43 }, () => 'device-online')
    const title = windowTitle('it', kinds)
    expect(title).toBe('43 dispositivi di nuovo online')
    expect(title).not.toContain('Offline')
  })

  it('names low batteries, consumables and critical alerts, in both languages', () => {
    expect(
      windowTitle('it', ['device-battery-low', 'device-battery-low', 'device-battery-low']),
    ).toBe('3 batterie scariche')
    expect(windowTitle('en', ['device-battery-low', 'device-battery-low'])).toBe('2 low batteries')
    expect(windowTitle('en', ['device-battery-low'])).toBe('1 low battery')
    expect(windowTitle('it', ['device-consumable-low', 'device-consumable-low'])).toBe(
      '2 consumabili da sostituire',
    )
    expect(windowTitle('en', ['device-consumable-low'])).toBe('1 consumable to replace')
    expect(windowTitle('it', ['alert-critical', 'alert-critical'])).toBe('2 avvisi critici')
    expect(windowTitle('en', ['alert-critical'])).toBe('1 critical alert')
    expect(windowTitle('it', ['alert-critical-resolved', 'alert-critical-resolved'])).toBe(
      '2 avvisi critici risolti',
    )
    expect(windowTitle('en', ['alert-critical-resolved'])).toBe('1 critical alert resolved')
    expect(windowTitle('it', ['alert-error', 'alert-error'])).toBe('2 avvisi di errore')
    expect(windowTitle('en', ['alert-error'])).toBe('1 error alert')
  })

  it('names nodes and update bursts with the count, not the section', () => {
    expect(windowTitle('it', ['node-online', 'node-online'])).toBe('2 nodi di nuovo online')
    expect(windowTitle('it', ['node-offline', 'node-offline'])).toBe('2 nodi offline')
    expect(windowTitle('en', ['node-offline'])).toBe('1 node offline')
    expect(windowTitle('it', ['addon-update-available', 'server-update-available'])).toBe(
      '2 aggiornamenti disponibili',
    )
    expect(windowTitle('en', ['wrapper-update-available'])).toBe('1 update available')
  })

  it('a mixed burst keeps the section summary, and an authored title still wins', () => {
    expect(windowTitle('it', ['device-offline', 'device-online', 'device-online'])).toBe(
      '1 offline, 2 di nuovo online',
    )
    expect(windowTitle('it', ['device-online', 'device-battery-low'])).toBe(
      'Offline o spenti, Batterie scariche: 2',
    )
    expect(
      windowTitle(
        'it',
        ['alert-critical', 'alert-critical-resolved'],
        undefined,
        'Allarmi critici',
      ),
    ).toBe('Allarmi critici: 2')
    expect(
      windowTitle('it', ['device-battery-low', 'device-battery-low'], '{{rule}}: tenuto'),
    ).toBe('Dispositivi: tenuto')
  })
})
