import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  mapBaichuanWebhookToSimpleEvents,
  parseBaichuanWebhookBody,
  type ReolinkSimpleEvent,
} from '@apocaliss92/nodelink-js'
import type { DataPlaneHandler, IScopedLogger } from '@camstack/types'

/**
 * The Baichuan HaCfg webhook (battery sleep push, cmd 807) as a plane of this addon's HTTP data
 * plane: a camera POSTs `{"event":"wake","reason":"pir"}` to
 * `http://<internal-host>:<lan-http-port>/addon/provider-reolink/webhook/<stableId>`. The hub
 * proxies it without auth (`access: 'public'`: the firmware cannot sign in), so this handler is
 * the whole gate: a known battery camera, a small JSON body, nothing else.
 */

/** The firmware's body is a few dozen bytes; this bounds what an unauthenticated peer can make us hold. */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024

/** What the plane needs of a camera. */
export interface WebhookCamera {
  readonly id: number
  readonly stableId: string
  readonly isEmailPushEligible: boolean
  readonly emailPushChannel: number
  handleSimpleEvent(event: ReolinkSimpleEvent): void
}

export interface WebhookPlaneDeps {
  readonly logger: IScopedLogger
  readonly listCameras: () => readonly WebhookCamera[]
}

class BodyTooLarge extends Error {}

function reply(res: ServerResponse, status: number, allow?: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain',
    ...(allow === undefined ? {} : { allow }),
  })
  res.end()
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > WEBHOOK_MAX_BODY_BYTES) throw new BodyTooLarge()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** The stable id in `req.url` (`/<id>`, already stripped of the plane's prefix), or null. */
function stableIdOf(url: string | undefined): string | null {
  const path = (url ?? '').split('?')[0] ?? ''
  const segment = path.replace(/^\/+/, '')
  if (segment.length === 0 || segment.includes('/')) return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

export function createWebhookHandler(deps: WebhookPlaneDeps): DataPlaneHandler {
  const { logger } = deps
  return async (req, res) => {
    if (req.method !== 'POST' && req.method !== 'PUT') {
      reply(res, 405, 'POST, PUT')
      return
    }
    const stableId = stableIdOf(req.url)
    const camera =
      stableId === null ? undefined : deps.listCameras().find((c) => c.stableId === stableId)
    if (camera === undefined || !camera.isEmailPushEligible) {
      // Only a camera we know has a device id to tag; an unknown id is the peer's claim.
      logger.warn('baichuan-webhook: push for an unknown or ineligible camera — refused', {
        ...(camera === undefined ? {} : { tags: { deviceId: camera.id } }),
        meta: { stableId: stableId ?? '(none)', known: camera !== undefined },
      })
      reply(res, 404)
      return
    }
    let body: Buffer
    try {
      body = await readBody(req)
    } catch (err) {
      const tooLarge = err instanceof BodyTooLarge
      logger.warn(
        tooLarge
          ? 'baichuan-webhook: push body over the bound — refused'
          : 'baichuan-webhook: push body unreadable — refused',
        { tags: { deviceId: camera.id }, meta: { maxBytes: WEBHOOK_MAX_BODY_BYTES } },
      )
      reply(res, tooLarge ? 413 : 400)
      if (tooLarge) req.destroy()
      return
    }
    const parsed = parseBaichuanWebhookBody(body)
    if (parsed === undefined) {
      logger.warn('baichuan-webhook: push body is not a webhook payload — refused', {
        tags: { deviceId: camera.id },
      })
      reply(res, 400)
      return
    }
    if (parsed.kind !== 'event') {
      logger.debug('baichuan-webhook: command-shaped push ignored', {
        tags: { deviceId: camera.id },
        meta: { cmdId: parsed.cmdId },
      })
      reply(res, 202)
      return
    }
    const types = mapBaichuanWebhookToSimpleEvents({ event: parsed.event, reason: parsed.reason })
    logger.info('baichuan-webhook: event received from battery camera', {
      tags: { deviceId: camera.id },
      meta: { event: parsed.event, reason: parsed.reason, types },
    })
    const timestamp = Date.now()
    for (const type of types) {
      camera.handleSimpleEvent({
        type,
        channel: camera.emailPushChannel,
        timestamp,
        source: 'baichuanWebhook',
      })
    }
    reply(res, 200)
  }
}
