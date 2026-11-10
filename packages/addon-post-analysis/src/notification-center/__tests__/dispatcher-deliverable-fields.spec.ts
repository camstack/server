/**
 * #483 — the dispatcher sends a target only the fields its KIND delivers
 * (`NcTargetRef.fields`, from `deliverableFields`). A title-only speaker gets
 * the title and an empty body — nothing joined to it. A target whose kind the
 * catalog did not answer keeps everything.
 */
import {
  type IScopedLogger,
  NC_TEMPLATE_TITLE_MAX_CHARS,
  type NotificationField,
} from '@camstack/types'
import { describe, expect, it, type MockInstance, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcSendInput } from '../dispatcher.js'
import type { NcOutboxEntry } from '../outbox.js'

interface Template {
  readonly title: string
  readonly body: string
}

const DEFAULT_TEMPLATE: Template = { title: 'Someone at {{device}}', body: 'A person was seen' }

function entry(template: Template): NcOutboxEntry {
  return {
    id: 'rule-1:trk-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: 101,
    recordKind: 'object-event',
    recordId: 'ev-1',
    trackId: 'trk-1',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 100,
    updatedAt: 100,
    payload: {
      ruleName: 'Person at gate',
      delivery: 'immediate',
      priority: 4,
      media: 'none',
      template,
      params: { sound: 'chime' },
      subject: {
        deviceId: 101,
        trackId: 'trk-1',
        eventId: 'ev-1',
        className: 'person',
        zones: [],
        timestamp: 1_753_000_000_000,
      },
    },
  }
}

interface Delivered {
  readonly sent: NcSendInput
  readonly info: MockInstance<IScopedLogger['info']>
}

async function sendTo(
  fields: readonly NotificationField[] | undefined,
  template: Template = DEFAULT_TEMPLATE,
): Promise<Delivered> {
  const sends: NcSendInput[] = []
  const logger = makeSilentLogger()
  const info = vi.spyOn(logger, 'info')
  const dispatcher = new NcDispatcher({
    logger,
    listTargets: async () => [
      {
        id: 'tgt-1',
        addonId: 'x',
        name: 'kitchen',
        kind: 'k',
        enabled: true,
        ...(fields !== undefined ? { fields } : {}),
      },
    ],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => 'Cancello',
    now: () => 1_800_000_000_000,
  })
  await dispatcher.deliver(entry(template))
  const [sent] = sends
  if (sent === undefined) throw new Error('nothing was sent')
  return { sent, info }
}

describe('NcDispatcher — deliverable fields (#483)', () => {
  it('a title-only target gets the title, an empty body, no priority and no sound', async () => {
    const { sent, info } = await sendTo(['title'])
    expect(sent.notification.title).toBe('Someone at cancello')
    expect(sent.notification.body).toBe('')
    expect(sent.notification.priority).toBeUndefined()
    expect(sent.notification.sound).toBeUndefined()
    const line = info.mock.calls.find(([msg]) => msg === 'notification delivered')
    expect(line?.[1]).toMatchObject({
      tags: { deviceId: 101 },
      meta: { fieldsDropped: ['body', 'priority', 'sound'] },
    })
  })

  it('a target that delivers everything is sent everything', async () => {
    const { sent } = await sendTo(['title', 'body', 'priority', 'sound', 'clickUrl'])
    expect(sent.notification.title).toBe('Someone at cancello')
    expect(sent.notification.body).toBe('A person was seen')
    expect(sent.notification.priority).toBe(4)
    expect(sent.notification.sound).toBe('chime')
  })

  it('an unknown kind (no declaration read) drops nothing', async () => {
    const { sent } = await sendTo(undefined)
    expect(sent.notification.body).toBe('A person was seen')
    expect(sent.notification.sound).toBe('chime')
  })

  // An empty authored title falls back to the rule name before this point; the
  // title that reaches a target empty is one whose variables render to nothing.
  const EMPTY_RENDERED_TITLE = '{{noSuchVariable}} '

  it('a title-only target whose title renders empty speaks the body, cut to the title limit', async () => {
    const body = `A person was seen at {{device}} ${'x'.repeat(NC_TEMPLATE_TITLE_MAX_CHARS)}`
    const { sent, info } = await sendTo(['title'], { title: EMPTY_RENDERED_TITLE, body })
    expect(sent.notification.title).toBe(
      `A person was seen at cancello ${'x'.repeat(NC_TEMPLATE_TITLE_MAX_CHARS)}`.slice(
        0,
        NC_TEMPLATE_TITLE_MAX_CHARS,
      ),
    )
    expect(sent.notification.body).toBe('')
    const line = info.mock.calls.find(([msg]) => msg === 'notification delivered')
    expect(line?.[1]).toMatchObject({ meta: { titleFromBody: true } })
  })

  it('a target that also delivers the body keeps an empty title empty', async () => {
    const { sent, info } = await sendTo(['title', 'body'], {
      title: EMPTY_RENDERED_TITLE,
      body: 'A person was seen',
    })
    expect(sent.notification.title?.trim() ?? '').toBe('')
    expect(sent.notification.body).toBe('A person was seen')
    const line = info.mock.calls.find(([msg]) => msg === 'notification delivered')
    expect(line?.[1]).not.toMatchObject({ meta: { titleFromBody: true } })
  })
})
