/**
 * The inbound mailboxes as `integration-instances` (D1013): one instance per `mailboxes` record,
 * over the SAME records and ids the `smtp-inbound` broker serves; the `mailboxes` kind of the
 * composed provider (the relays are the `relays` kind). A change re-applies the listener; removing
 * a mailbox a subscriber (camera email push) still reads is refused.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import {
  assertBrokerUnused,
  type BrokerUserFinder,
  type IntegrationInstanceStatus,
  type IntegrationTestConnectionResult,
  type IIntegrationInstancesProvider,
  RecordIntegrationInstances,
  type RecordsAccess,
  SmtpInboundSettingsSchema,
} from '@camstack/types'
import { probeBind } from './bind-probe.js'
import { mailboxSettingsSchema, type SmtpInboundBroker } from './inbound-broker.js'
import { type MailboxBody, MailboxBodySchema, mailboxesKind } from './mailbox-record-kinds.js'

export const MAILBOX_INSTANCE_KIND = 'mailboxes'

type MailboxRuntime = NonNullable<ReturnType<SmtpInboundBroker['runtimeOf']>>

function statusOf(runtime: MailboxRuntime | null): IntegrationInstanceStatus {
  if (runtime === null) return { state: 'unknown', label: 'Not listening' }
  if (runtime.status === 'connected') return { state: 'ok', label: 'Listening' }
  return {
    state: 'error',
    label: runtime.status,
    ...(runtime.error !== null ? { detail: runtime.error } : {}),
  }
}

export function newMailboxBody(name: string): MailboxBody {
  const defaults = SmtpInboundSettingsSchema.parse({})
  return MailboxBodySchema.parse({
    name,
    port: defaults.port,
    bindHost: defaults.bindHost,
    domain: defaults.domain,
    requireAuth: defaults.requireAuth,
    username: `camstack-${randomBytes(4).toString('hex')}`,
    password: randomBytes(18).toString('base64url'),
    starttls: defaults.starttls,
    maxMessageBytes: defaults.maxMessageBytes,
  })
}

export interface MailboxInstancesDeps {
  readonly inbound: Pick<SmtpInboundBroker, 'reconcileMailbox' | 'runtimeOf' | 'subscriberUsers'>
}

export function buildMailboxInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: MailboxInstancesDeps,
): IIntegrationInstancesProvider {
  const users: BrokerUserFinder = deps.inbound.subscriberUsers()
  const instances = new RecordIntegrationInstances<MailboxBody>(records, mailboxesKind, {
    description: { role: 'services', instanceMode: 'multiple', kind: 'mailbox', canTest: true },
    formSchema: () => mailboxSettingsSchema(),
    initialBody: (name) => newMailboxBody(name),
    mintId: () => `smtp-inbound-${randomUUID().slice(0, 8)}`,
    configured: () => true,
    health: (_body, id) => {
      const runtime = deps.inbound.runtimeOf(id)
      return {
        status: statusOf(runtime),
        ...(runtime !== null ? { lastCheckedAt: runtime.checkedAt } : {}),
      }
    },
    onChanged: (id) => deps.inbound.reconcileMailbox(id),
    test: async ({ id, values }): Promise<IntegrationTestConnectionResult> => {
      // Before the mailbox exists the question is "can this port be taken?" (the create form).
      if (id === null) {
        const parsed = SmtpInboundSettingsSchema.safeParse(values)
        if (!parsed.success) {
          return { success: false, status: 'rejected', error: parsed.error.message }
        }
        const bound = await probeBind(parsed.data.port, parsed.data.bindHost)
        return bound.ok
          ? { success: true, status: 'validated', latencyMs: bound.latencyMs }
          : { success: false, status: 'rejected', error: bound.error }
      }
      const runtime = deps.inbound.runtimeOf(id)
      return runtime?.status === 'connected'
        ? { success: true, status: 'validated' }
        : {
            success: false,
            status: 'rejected',
            error: runtime?.error ?? 'The mailbox is not listening',
          }
    },
  })
  const base = instances.toProvider()
  return {
    ...base,
    deleteInstance: async (input) => {
      await assertBrokerUnused(input.id, [users])
      return base.deleteInstance(input)
    },
  }
}
