/**
 * The camera-mail intake moves from this addon's own SMTP server to a mailbox of the
 * `smtp-inbound` broker. Every camera already points at port, domain, username and password,
 * so the mailbox is created carrying exactly those: no camera is reconfigured.
 */
import { defineAddonMigrations, type MigrationOwnerResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  EMAIL_PUSH_TO_MAILBOX_ID,
  REOLINK_MIGRATIONS,
  type EmailPushMigrationPorts,
} from '../migrations/index.js'

/** A key the migration does not know: it must survive untouched. */
const MARK = { someUnrelatedKey: 'keep-me' }

function world(
  stored: Record<string, unknown>,
  options: { readFails?: boolean; existing?: boolean; addFails?: string } = {},
) {
  const mailboxes: Array<Record<string, unknown>> = []
  const warnings: string[] = []
  const ports: EmailPushMigrationPorts = {
    readStored: async () => {
      if (options.readFails === true) throw new Error('keychain locked')
      return stored
    },
    addMailbox: async (settings) => {
      if (options.addFails !== undefined) throw new Error(options.addFails)
      if (options.existing === true) return 'exists'
      mailboxes.push({ ...settings })
      return 'created'
    },
    warn: (message) => {
      warnings.push(message)
    },
  }
  const bound = defineAddonMigrations(REOLINK_MIGRATIONS, ports)
  const run = async (): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === EMAIL_PUSH_TO_MAILBOX_ID)
    if (entry === undefined) throw new Error('migration not in the catalogue')
    return entry.execute()
  }
  return { mailboxes, warnings, run, stored }
}

const OLD = {
  emailPushEnabled: true,
  emailPushPort: 2525,
  emailPushDomain: 'cams.home',
  emailPushRequireAuth: true,
  emailPushAuthUsername: 'camstack-ab12cd34',
  emailPushAuthPassword: 'pw-secret',
  ...MARK,
}

describe('email push -> mailbox migration', () => {
  it('creates the mailbox carrying the port, domain, username and password the cameras use', async () => {
    const w = world(OLD)
    const result = await w.run()
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    expect(w.mailboxes).toEqual([
      {
        port: 2525,
        domain: 'cams.home',
        requireAuth: true,
        username: 'camstack-ab12cd34',
        password: 'pw-secret',
      },
    ])
  })

  it('keeps a non-default port exactly', async () => {
    const w = world({ ...OLD, emailPushPort: 2626 })
    await w.run()
    expect(w.mailboxes[0]?.['port']).toBe(2626)
  })

  it('does nothing for an install that never configured the intake', async () => {
    const w = world({ ...MARK })
    const result = await w.run()
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'already-done' } })
    expect(w.mailboxes).toEqual([])
  })

  it('a mailbox that already exists is already-done, never replaced', async () => {
    const w = world(OLD, { existing: true })
    const result = await w.run()
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'already-done' } })
    expect(w.mailboxes).toEqual([])
  })

  it('a password that cannot be read fails the run and writes no mailbox (never read as empty)', async () => {
    const w = world(OLD, { readFails: true })
    const result = await w.run()
    expect(result.kind).toBe('failed')
    expect(JSON.stringify(result)).not.toContain('pw-secret')
    expect(w.mailboxes).toEqual([])
  })

  it('an unavailable mail addon fails the run so the next boot retries', async () => {
    const w = world(OLD, { addFails: 'no provider for broker' })
    const result = await w.run()
    expect(result.kind).toBe('failed')
  })
})
