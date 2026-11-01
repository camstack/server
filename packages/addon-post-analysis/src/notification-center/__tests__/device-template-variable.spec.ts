/**
 * `{{device}}` is the name of the device the event is about — a rule on an appliance or a
 * sensor names that device, not a camera. `{{camera}}` is a deprecated alias: it still
 * renders (a template saved by an older client), the catalog never offers it, and the rule
 * that still uses it is named once in the log.
 */
import type { IScopedLogger } from '@camstack/types'
import { isKnownTemplateVar } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NcDispatcher } from '../dispatcher.js'
import type { NcOutboxEntry } from '../outbox.js'

interface LoggedWarn {
  readonly message: string
  readonly tags: unknown
}

function recordingLogger(warns: LoggedWarn[]): IScopedLogger {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: (message, options) => {
      warns.push({ message, tags: options?.tags })
    },
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function applianceEntry(
  ruleId: string,
  template: { title?: string; body?: string },
): NcOutboxEntry {
  return {
    id: `${ruleId}:evt:tgt-1`,
    ruleId,
    targetId: 'tgt-1',
    deviceId: 501,
    recordKind: 'system-event',
    recordId: 'evt-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 100,
    updatedAt: 100,
    payload: {
      ruleName: 'Dishwasher done',
      delivery: 'system-event',
      priority: 3,
      media: 'none',
      template,
      subject: {
        deviceId: 501,
        className: 'event',
        zones: [],
        timestamp: 1_753_000_000_000,
        systemEvent: {
          kind: 'device-offline',
          subject: 'device:501',
          deviceId: 501,
          title: 'Offline',
          body: 'Offline',
          data: { category: 'device.offline' },
        },
      },
    },
  }
}

function harness() {
  const warns: LoggedWarn[] = []
  const sent: { title: string; body: string }[] = []
  const dispatcher = new NcDispatcher({
    logger: recordingLogger(warns),
    listTargets: async () => [
      {
        id: 'tgt-1',
        addonId: 'notifiers',
        name: 'Phone',
        kind: 'pushover',
        enabled: true,
      },
    ],
    send: async (input) => {
      sent.push({
        title: input.notification.title ?? '',
        body: input.notification.body,
      })
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async (id) => (id === 501 ? 'Dishwasher' : null),
  })
  return { dispatcher, warns, sent }
}

describe('{{device}} on a device event of an appliance', () => {
  it('renders the appliance name, with nothing logged', async () => {
    const h = harness()
    await h.dispatcher.deliver(
      applianceEntry('rule-a', {
        title: '{{device}} finished',
        body: 'Check {{ device }}',
      }),
    )
    expect(h.sent).toEqual([{ title: 'dishwasher finished', body: 'Check dishwasher' }])
    expect(h.warns).toEqual([])
  })

  it('still renders the deprecated {{camera}} alias and names the rule ONCE', async () => {
    const h = harness()
    const entry = applianceEntry('rule-b', {
      title: '{{camera}} finished',
      body: '{{ camera }}',
    })
    await h.dispatcher.deliver(entry)
    await h.dispatcher.deliver(entry)
    expect(h.sent.map((s) => s.title)).toEqual(['dishwasher finished', 'dishwasher finished'])
    expect(h.sent.map((s) => s.body)).toEqual(['Dishwasher', 'Dishwasher'])
    expect(h.warns).toHaveLength(1)
    expect(h.warns[0]?.tags).toEqual({ ruleId: 'rule-b' })
  })
})

describe('the catalog', () => {
  it('declares device and no longer offers camera', () => {
    const ctx = { family: 'rule', field: 'body', kind: 'detection' } as const
    expect(isKnownTemplateVar('device', ctx)).toBe(true)
    expect(isKnownTemplateVar('camera', ctx)).toBe(false)
  })
})
