import { describe, expect, it } from 'vitest'
import {
  SmtpInboundConfigSchema,
  SmtpInboundFilterSchema,
  SmtpInboundMessageSchema,
  SmtpInboundSettingsSchema,
  parseSmtpSinceKey,
  smtpSinceKey,
} from '../brokers/smtp-inbound.js'

describe('smtp-inbound schemas', () => {
  it('settings default to the port and domain cameras are already pointed at', () => {
    const parsed = SmtpInboundSettingsSchema.parse({})
    expect(parsed.port).toBe(2525)
    expect(parsed.domain).toBe('camstack.local')
    expect(parsed.requireAuth).toBe(true)
  })

  it('a filter needs at least one valid local-part', () => {
    expect(SmtpInboundFilterSchema.safeParse({ recipients: [] }).success).toBe(false)
    expect(SmtpInboundFilterSchema.safeParse({ recipients: ['a@b'] }).success).toBe(false)
    expect(
      SmtpInboundFilterSchema.safeParse({
        recipients: ['cam-9527000HZ56U1ORU'],
      }).success,
    ).toBe(true)
  })

  it('a config may carry a null host, never an empty one', () => {
    const base = {
      hostReason: 'x',
      port: 2525,
      domain: 'd',
      requireAuth: true,
      username: 'u',
      password: 'p',
      starttls: false,
    }
    expect(SmtpInboundConfigSchema.safeParse({ ...base, host: null }).success).toBe(true)
    expect(SmtpInboundConfigSchema.safeParse({ ...base, host: '' }).success).toBe(false)
  })

  it('a message text beyond 4 KiB is refused', () => {
    const msg = {
      seq: 1,
      messageId: 'm',
      receivedAt: 1,
      from: 'a',
      to: 'b',
      subject: 's',
      text: 'x'.repeat(4097),
      attachments: [],
    }
    expect(SmtpInboundMessageSchema.safeParse(msg).success).toBe(false)
    expect(SmtpInboundMessageSchema.safeParse({ ...msg, text: 'x' }).success).toBe(true)
  })

  it('the since key round-trips and rejects other keys', () => {
    expect(parseSmtpSinceKey(smtpSinceKey(7))).toBe(7)
    expect(parseSmtpSinceKey('since:x')).toBeNull()
    expect(parseSmtpSinceKey('other')).toBeNull()
  })
})
