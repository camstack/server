import type { AddressInfo } from 'node:net'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LEGACY_WEBHOOK_RETIRE_AFTER,
  type LegacyWebhookIntake,
  startLegacyWebhookIntake,
} from '../legacy-webhook-intake.js'
import { createWebhookHandler, type WebhookCamera } from '../webhook-plane.js'

const warns: { message: string; tags: unknown }[] = []
const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, options) => {
    warns.push({ message, tags: options?.tags })
  },
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

let intake: LegacyWebhookIntake | undefined
afterEach(async () => {
  await intake?.close()
  intake = undefined
  warns.length = 0
})

describe('legacy :9081 webhook intake', () => {
  it('feeds the same handler, logs once per camera, and refuses an unknown id like the plane', async () => {
    const events: string[] = []
    const camera: WebhookCamera = {
      id: 7,
      stableId: 'mac-aa',
      isEmailPushEligible: true,
      emailPushChannel: 0,
      handleSimpleEvent: (e) => {
        events.push(`${e.type}:${e.source}`)
      },
    }
    const listCameras = () => [camera]
    intake = await startLegacyWebhookIntake({
      logger,
      listCameras,
      handler: createWebhookHandler({ logger, listCameras }),
      port: 0,
    })
    const { port } = intake.server.address() as AddressInfo
    const post = (path: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        body: JSON.stringify({ event: 'wake', reason: 'pir' }),
      })
    expect((await post('/webhook/mac-aa')).status).toBe(200)
    expect((await post('/webhook/mac-aa')).status).toBe(200)
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.endsWith(':baichuanWebhook'))).toBe(true)
    const legacy = warns.filter((w) => w.message.includes('legacy webhook port used'))
    expect(legacy).toHaveLength(1)
    expect(legacy[0]?.tags).toEqual({ deviceId: 7 })
    expect((await post('/webhook/nobody')).status).toBe(404)
  })

  it('is retired after its window: delete legacy-webhook-intake.ts and its wiring', () => {
    expect(new Date().toISOString().slice(0, 10) <= LEGACY_WEBHOOK_RETIRE_AFTER).toBe(true)
  })
})
