import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import type { RelayTransport, TransportFactory } from '../relay-pool.js'

export interface FakeTransport extends RelayTransport {
  readonly options: SMTPTransport.Options
  readonly sent: SMTPTransport.MailOptions[]
  closed: boolean
}

/** A transporter factory that records what each relay was built with and what it was asked to send. */
export function fakeFactory(): { factory: TransportFactory; built: FakeTransport[] } {
  const built: FakeTransport[] = []
  const factory: TransportFactory = (options) => {
    const transport: FakeTransport = {
      options,
      sent: [],
      closed: false,
      sendMail: async (mail) => {
        transport.sent.push(mail)
        return {
          messageId: `<${options.host}-${transport.sent.length}>`,
          accepted: [],
          rejected: [],
        }
      },
      verify: async () => true,
      close: () => {
        transport.closed = true
      },
    }
    built.push(transport)
    return transport
  }
  return { factory, built }
}
