/**
 * Every registered notifier kind, in catalog order.
 *
 * One list, imported by the addon (which multiplexes them behind its
 * `notification-output` provider) AND by the specs that must hold for every
 * kind — so a new adapter is covered by those specs the day it is added,
 * instead of whenever someone remembers to extend a hand-written table.
 */
import type { HttpNotifierAdapter, NotifierAdapter } from './adapter.js'
import { discordAdapter } from './discord.js'
import type { EmailSmtpClient } from './email.js'
import { createEmailAdapter } from './email.js'
import { gotifyAdapter } from './gotify.js'
import { ntfyAdapter } from './ntfy.js'
import { pushoverAdapter } from './pushover.js'
import { telegramAdapter } from './telegram.js'
import { webhookAdapter } from './webhook.js'
import { whatsappAdapter } from './whatsapp.js'
import { zentikAdapter } from './zentik.js'

/** HTTP adapters that need no runtime deps. */
export const HTTP_NOTIFIER_ADAPTERS: readonly HttpNotifierAdapter[] = [
  ntfyAdapter,
  pushoverAdapter,
  gotifyAdapter,
  telegramAdapter,
  discordAdapter,
  webhookAdapter,
  zentikAdapter,
  whatsappAdapter,
]

/**
 * Full catalog. When `smtp` is omitted the Email kind is still listed but
 * `sendDirect` fails until the addon wires a client (tests use this).
 */
export function buildNotifierAdapters(smtp?: EmailSmtpClient): readonly NotifierAdapter[] {
  const emailSmtp: EmailSmtpClient = smtp ?? {
    async sendEmail() {
      throw new Error(
        'email: no smtp-provider client — install Google Services or SMTP Email under Connectivity → Email and Verify it',
      )
    },
  }
  return [...HTTP_NOTIFIER_ADAPTERS, createEmailAdapter(emailSmtp)]
}

/** Default export for specs that only need HTTP kinds + a stub email. */
export const NOTIFIER_ADAPTERS: readonly NotifierAdapter[] = buildNotifierAdapters()
