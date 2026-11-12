/**
 * `{{device}}`, `{{deviceName}}` and everything built from the device's name
 * stay the BARE name; only `{{deviceLabel}}` carries the translated type.
 */
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcSendInput } from '../dispatcher.js'
import type { NcDeviceIdentity } from '../device-directory.js'
import type { NcOutboxEntry } from '../outbox.js'

const IDENTITY: NcDeviceIdentity = {
  deviceId: 101,
  type: DeviceType.Camera,
  name: 'Cancello',
  isCamera: true,
}

function entry(body: string): NcOutboxEntry {
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
      template: { body },
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

async function bodyOf(row: NcOutboxEntry): Promise<string> {
  const sends: NcSendInput[] = []
  const dispatcher = new NcDispatcher({
    logger: makeSilentLogger(),
    listTargets: async () => [
      { id: 'tgt-1', addonId: 'x', name: 'echo', kind: 'k', enabled: true },
    ],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async () => [],
    getDeviceName: async () => 'Cancello',
    deviceIdentity: () => IDENTITY,
    now: () => 1_800_000_000_000,
  })
  await dispatcher.deliver(row)
  const [first] = sends
  if (first === undefined) throw new Error('nothing was sent')
  return first.notification.body
}

describe('the device name a notification carries', () => {
  it('{{device}} stays the bare name and {{deviceLabel}} adds the type', async () => {
    expect(await bodyOf(entry('{{device}} | {{deviceLabel}}'))).toBe('Cancello | Cancello (Camera)')
  })

  it('an authored label stays labelled while the default sentence stays bare', async () => {
    const body = await bodyOf(entry('{{deviceLabel}}'))
    expect(body).toBe('Cancello (Camera)')
    const plain = await bodyOf({
      ...entry('x'),
      payload: { ...entry('x').payload, template: undefined },
    })
    expect(plain).not.toContain('(Camera)')
  })
})
