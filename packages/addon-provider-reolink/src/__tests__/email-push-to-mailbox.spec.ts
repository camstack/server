/**
 * The camera-mail intake moves from this addon's own SMTP server to a mailbox of the
 * `smtp-inbound` broker. Every camera already points at port, domain, username and password,
 * so the mailbox is created carrying exactly those: no camera is reconfigured.
 */
import {
  type AddonMigrationHost,
  type IScopedLogger,
  type MigrationOwnerResult,
  defineAddonMigrations,
  runAddonMigrations,
} from '@camstack/types'
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
  options: { readFails?: boolean; stashFails?: string } = {},
) {
  const pending: Array<Record<string, unknown>> = []
  const warnings: string[] = []
  const ports: EmailPushMigrationPorts = {
    readStored: async () => {
      if (options.readFails === true) throw new Error('keychain locked')
      return stored
    },
    stashPending: async (settings) => {
      if (options.stashFails !== undefined) throw new Error(options.stashFails)
      pending.push({ ...settings })
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
  /** Drive the catalogue the way `runMigrations` does, so the owner's fate is observable. */
  const runAsOwner = async () => {
    const host: AddonMigrationHost = {
      declareOwner: async ({ metas }) => ({
        bootId: 'b1',
        snapshot: 'none',
        steps: metas.map((m) => ({
          id: m.id,
          action: 'run',
          state: 'pending',
        })),
      }),
      startMigration: async () => ({
        proceed: true,
        state: 'pending',
        reason: null,
      }),
      finishMigration: async ({ result }) =>
        result.kind === 'failed'
          ? { status: 'failed', error: result.error, rowsChanged: 0 }
          : { status: 'applied', error: null, rowsChanged: 0 },
    }
    return runAddonMigrations(host, bound, quiet)
  }
  return { pending, warnings, run, runAsOwner, stored }
}

const quiet = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return this
  },
  withTags() {
    return this
  },
} as unknown as IScopedLogger

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
  it('keeps the port, domain, username and password the cameras use as the pending mailbox', async () => {
    const w = world(OLD)
    const result = await w.run()
    expect(result).toMatchObject({
      kind: 'procedure',
      result: { outcome: 'done' },
    })
    expect(w.pending).toEqual([
      {
        port: 2525,
        domain: 'cams.home',
        requireAuth: true,
        username: 'camstack-ab12cd34',
        password: 'pw-secret',
      },
    ])
  })

  it('keeps a non-default port and a bind host exactly', async () => {
    const w = world({
      ...OLD,
      emailPushPort: 2626,
      emailPushBindHost: '192.0.2.7',
    })
    await w.run()
    expect(w.pending[0]).toMatchObject({ port: 2626, bindHost: '192.0.2.7' })
  })

  it('an intake the operator had switched off carries nothing', async () => {
    const w = world({ ...OLD, emailPushEnabled: false })
    const result = await w.run()
    expect(result).toMatchObject({
      kind: 'procedure',
      result: { outcome: 'already-done' },
    })
    expect(w.pending).toEqual([])
  })

  it('does nothing for an install that never configured the intake', async () => {
    const w = world({ ...MARK })
    const result = await w.run()
    expect(result).toMatchObject({
      kind: 'procedure',
      result: { outcome: 'already-done' },
    })
    expect(w.pending).toEqual([])
  })

  it('a password that cannot be read fails the run and keeps nothing (never read as empty)', async () => {
    const w = world(OLD, { readFails: true })
    const result = await w.run()
    expect(result.kind).toBe('failed')
    expect(JSON.stringify(result)).not.toContain('pw-secret')
    expect(w.pending).toEqual([])
  })

  it('a failed run never blocks the addon: Reolink boots and runs its cameras without a mail provider', async () => {
    for (const options of [{ readFails: true }, { stashFails: 'disk full' }]) {
      const w = world(OLD, options)
      const report = await w.runAsOwner()
      expect(report.failed).toEqual([EMAIL_PUSH_TO_MAILBOX_ID])
      // `runMigrations` throws (and `onInitialize` aborts) exactly when this list is not empty.
      expect(report.blockOwner).toEqual([])
    }
  })

  it('the catalogue names no mail provider: the ports are local only', async () => {
    const w = world(OLD)
    const report = await w.runAsOwner()
    expect(report.applied).toEqual([EMAIL_PUSH_TO_MAILBOX_ID])
    expect(w.pending).toHaveLength(1)
  })
})
