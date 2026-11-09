/**
 * A rule's authored title/body may carry device value templates (D1021). They
 * are rendered by the hub's one renderer, on the authored text only, before the
 * `{{var}}` pass.
 */
import type { DeviceTemplateRender } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcSendInput } from '../dispatcher.js'
import type { NcRenderDeviceTemplates } from '../device-template-pass.js'
import type { NcOutboxEntry } from '../outbox.js'

function entry(template: { title?: string; body?: string }): NcOutboxEntry {
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
      priority: 3,
      media: 'best',
      params: {},
      template,
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

async function send(
  row: NcOutboxEntry,
  render: NcRenderDeviceTemplates | undefined,
  deviceName = 'Cancello',
): Promise<{ sent: NcSendInput; warnings: string[] }> {
  const sends: NcSendInput[] = []
  const warnings: string[] = []
  const logger = makeSilentLogger()
  const dispatcher = new NcDispatcher({
    logger: {
      ...logger,
      warn: (msg: string) => {
        warnings.push(msg)
      },
    },
    listTargets: async () => [{ id: 'tgt-1', addonId: 'x', name: 'echo', kind: 'k', enabled: true }],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => deviceName,
    now: () => 1_800_000_000_000,
    ...(render === undefined ? {} : { renderDeviceTemplates: render }),
  })
  await dispatcher.deliver(row)
  const [first] = sends
  if (first === undefined) throw new Error('nothing was sent')
  return { sent: first, warnings }
}

const TEMP = "Temp {{ states('sensor.x') }} at {{device}}"
const answer = (text: string): DeviceTemplateRender => ({ ok: true, text, trace: [] })

describe('NcDispatcher — device templates in authored text (D1021)', () => {
  it('renders the device template through the hub renderer, then the {{var}} pass', async () => {
    const seen: string[] = []
    const render: NcRenderDeviceTemplates = async (templates) => {
      seen.push(...templates)
      return templates.map((t) => answer(t.replace("{{ states('sensor.x') }}", '21')))
    }
    const { sent } = await send(entry({ body: TEMP }), render)
    expect(sent.notification.body).toContain('21')
    expect(sent.notification.body).toContain('cancello')
    expect(seen.join()).not.toContain('{{device}}')
  })

  it('a variable VALUE is never rendered as a template', async () => {
    const seen: string[] = []
    const render: NcRenderDeviceTemplates = async (templates) => {
      seen.push(...templates)
      return templates.map((t) => answer(t))
    }
    const { sent } = await send(entry({ body: 'At {{device}}' }), render, "{{ states('sensor.x') }}")
    expect(seen).toEqual([])
    expect(sent.notification.body).toContain("{{ states('sensor.x') }}")
  })

  it('a refused render falls back to the catalog sentence and says why', async () => {
    const render: NcRenderDeviceTemplates = async () => [
      { ok: false, refusal: { reason: 'budget-exceeded', message: 'too slow' }, trace: [] },
    ]
    const { sent, warnings } = await send(entry({ body: TEMP }), render)
    expect(sent.notification.body).not.toContain('sensor.x')
    expect(warnings.some((w) => w.includes('device template'))).toBe(true)
  })
})
