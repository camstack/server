/**
 * The frame a notification's picture was built from is handed to the button
 * minter, so a verdict tap can copy exactly that frame into the retrain corpus.
 * It is bookkeeping: it never travels with the attachment.
 */

import type { MediaFile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDispatcher, type NcMintButtonsInput, type NcSendInput } from '../dispatcher.js'
import type { NcOutboxEntry } from '../outbox.js'

const T0 = 1_787_331_449_282

const entry: NcOutboxEntry = {
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
  createdAt: T0,
  updatedAt: T0,
  payload: {
    ruleName: 'Person at gate',
    delivery: 'immediate',
    priority: 3,
    media: 'best',
    mediaFrame: 'full',
    subject: {
      deviceId: 101,
      trackId: 'trk-1',
      eventId: 'ev-1',
      className: 'person',
      zones: [],
      timestamp: T0,
    },
  },
}

function file(kind: MediaFile['kind'], mediaId: number, timestamp: number): MediaFile {
  return makeTestMediaFile({
    kind,
    mediaId,
    base64: Buffer.from(`${kind}-bytes`).toString('base64'),
    timestamp,
  })
}

async function deliver(files: readonly MediaFile[]) {
  const sends: NcSendInput[] = []
  const minted: NcMintButtonsInput[] = []
  const dispatcher = new NcDispatcher({
    logger: makeSilentLogger(),
    listTargets: async () => [
      { id: 'tgt-1', addonId: 'notifiers', name: 'phone', kind: 'zentik', enabled: true },
    ],
    send: async (input) => {
      sends.push(input)
      return { success: true }
    },
    getMediaForOwner: async (ownerKind) => (ownerKind === 'track' ? files : []),
    getDeviceName: async () => 'Gate',
    buildActions: async (input) => {
      minted.push(input)
      return []
    },
    now: () => T0,
    sleep: async () => undefined,
  })
  await dispatcher.deliver(entry)
  return { sends, minted }
}

describe('the verdict buttons are minted with the frame the picture came from', () => {
  it('freezes the stored row the shipped still was rendered from', async () => {
    const { sends, minted } = await deliver([file('firstFrame', 7, T0 - 100), file('keyFrame', 4242, T0 + 50)])
    expect(sends[0]?.notification.attachments?.[0]?.name).toBe('keyFrame.jpg')
    expect(minted).toHaveLength(1)
    expect(minted[0]?.sourceMedia).toEqual({ mediaId: 4242, kind: 'keyFrame' })
  })

  it('does not ship the bookkeeping with the attachment', async () => {
    const { sends } = await deliver([file('keyFrame', 4242, T0)])
    expect(Object.keys(sends[0]?.notification.attachments?.[0] ?? {}).sort()).not.toContain(
      'sourceMedia',
    )
  })

  it('freezes nothing when no still landed', async () => {
    const { minted } = await deliver([])
    expect(minted).toHaveLength(1)
    expect(minted[0]?.sourceMedia).toBeUndefined()
  })
})
