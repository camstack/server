import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_PASSWORD_RESET_TRIGGER,
  reconcileAdminAccountAtBoot,
} from '../../builtins/local-auth/admin-account-boot.js'
import { AuthManager } from '../auth-manager.js'
import { staticJwtSigningKey } from '../jwt-signing-key.js'
import {
  FIRST_BOOT_ADMIN_PASSWORD,
  FIRST_BOOT_ADMIN_USERNAME,
  UserManager,
} from '../user-manager.js'

/**
 * The first-boot admin is `admin` / `changeme` — a SEED, never an authority,
 * and never configured: no env variable and no config.yaml key carries an
 * admin credential (D797). The first sign-in with `changeme` forces a change.
 *
 * The defect D728 fixed still holds: every boot used to compare the stored
 * hash with the configured password and rewrite it — so a password the
 * operator changed in the admin UI went back at the next restart. These tests
 * boot a REAL `UserManager` + `AuthManager` (bcrypt) over one in-memory users
 * table, change the password the way the UI does (`resetPassword`), and boot
 * again.
 */

interface Row {
  readonly id: string
  readonly data: Record<string, unknown>
}

/** One in-memory `users` table, shared across "boots". */
function makeUsersTable(): Map<string, Row> {
  return new Map<string, Row>()
}

function storeOver(rows: Map<string, Row>): SettingsStoreClient {
  const matches = (row: Row, where: Record<string, unknown> | undefined): boolean =>
    where === undefined || Object.entries(where).every(([k, v]) => row.data[k] === v)
  const client = {
    query: {
      query: async (input: { filter?: { where?: Record<string, unknown> } }) =>
        [...rows.values()].filter((r) => matches(r, input.filter?.where)),
    },
    insert: {
      mutate: async (input: { record: Row }) => {
        rows.set(input.record.id, input.record)
      },
    },
    update: {
      mutate: async (input: { id: string; data: Record<string, unknown> }) => {
        rows.set(input.id, { id: input.id, data: input.data })
      },
    },
    delete: {
      mutate: async (input: { key: string }) => {
        rows.delete(input.key)
      },
    },
  }
  // Type boundary: `SettingsStoreClient` is the generated tRPC client; the
  // user manager calls only the four procedures implemented above.
  return client as unknown as SettingsStoreClient
}

function logger(): IScopedLogger & { warn: ReturnType<typeof vi.fn> } {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withTags: () => log,
    child: () => log,
  }
  // Type boundary: the scoped logger's full surface is not exercised here.
  return log as unknown as IScopedLogger & { warn: ReturnType<typeof vi.fn> }
}

/** One hub boot. Nothing about the admin is configurable any more. */
function bootUsers(rows: Map<string, Row>): UserManager {
  const auth = new AuthManager(
    { get: () => undefined, update: () => undefined },
    undefined,
    staticJwtSigningKey('secret'),
  )
  return new UserManager({ getStore: () => storeOver(rows) }, auth)
}

let dataDir: string
const realFs = {
  exists: (p: string) => fs.existsSync(p),
  remove: (p: string) => fs.rmSync(p, { force: true }),
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-admin-seed-'))
})
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function boot(rows: Map<string, Row>) {
  const users = bootUsers(rows)
  const log = logger()
  const result = await reconcileAdminAccountAtBoot({ users, dataDir, fs: realFs, logger: log })
  return { users, log, result }
}

describe('admin password across restarts', () => {
  it('seeds admin / changeme on first boot', async () => {
    const rows = makeUsersTable()
    const { users, result } = await boot(rows)
    expect(result.outcome.kind).toBe('seeded')
    expect(await users.validateCredentials('admin', 'changeme')).not.toBeNull()
  })

  it('keeps a password changed in the UI across restarts', async () => {
    const rows = makeUsersTable()
    const first = await boot(rows)
    const admin = await first.users.findByUsername('admin')
    if (!admin) throw new Error('admin not seeded')
    await first.users.resetPassword(admin.id, 'operator-chosen')

    const second = await boot(rows)
    expect(second.result.outcome.kind).toBe('exists')
    expect(await second.users.validateCredentials('admin', 'operator-chosen')).not.toBeNull()
    expect(await second.users.validateCredentials('admin', 'changeme')).toBeNull()
  })

  it('the first-boot credentials are admin / changeme', () => {
    expect(FIRST_BOOT_ADMIN_USERNAME).toBe('admin')
    expect(FIRST_BOOT_ADMIN_PASSWORD).toBe('changeme')
  })

  it('does not seed `admin` when another admin account already exists', async () => {
    const rows = makeUsersTable()
    const users = bootUsers(rows)
    await users.create({ username: 'operator', password: 'pw', isAdmin: true })
    const outcome = await users.ensureAdminExists()
    expect(outcome.kind).toBe('other-admin-exists')
    expect(await users.findByUsername('admin')).toBeNull()
  })

  it('never overwrites an existing `admin` user, admin or not', async () => {
    const rows = makeUsersTable()
    const users = bootUsers(rows)
    await users.create({ username: 'admin', password: 'mine', isAdmin: false })
    const outcome = await users.ensureAdminExists()
    expect(outcome.kind).toBe('exists')
    expect(await users.validateCredentials('admin', 'mine')).not.toBeNull()
    expect(await users.validateCredentials('admin', 'changeme')).toBeNull()
  })

  it('ignores the retired CAMSTACK_ADMIN_USER / CAMSTACK_ADMIN_PASS variables', async () => {
    vi.stubEnv('CAMSTACK_ADMIN_USER', 'root')
    vi.stubEnv('CAMSTACK_ADMIN_PASS', 'from-env')
    try {
      const rows = makeUsersTable()
      const { users, result } = await boot(rows)
      expect(result.outcome).toEqual({ kind: 'seeded', username: 'admin' })
      expect(await users.findByUsername('root')).toBeNull()
      expect(await users.validateCredentials('admin', 'from-env')).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('the one-shot reset trigger', () => {
  it('resets `admin` to changeme once, then deletes the trigger', async () => {
    const rows = makeUsersTable()
    const first = await boot(rows)
    const admin = await first.users.findByUsername('admin')
    if (!admin) throw new Error('admin not seeded')
    await first.users.resetPassword(admin.id, 'forgotten')

    const trigger = path.join(dataDir, ADMIN_PASSWORD_RESET_TRIGGER)
    fs.writeFileSync(trigger, '')
    const second = await boot(rows)
    expect(second.result.outcome.kind).toBe('reset')
    expect(await second.users.validateCredentials('admin', 'changeme')).not.toBeNull()
    expect(fs.existsSync(trigger)).toBe(false)

    // The operator sets a new password; the trigger is gone, so it survives.
    await second.users.resetPassword(admin.id, 'new-one')
    const third = await boot(rows)
    expect(third.result.outcome.kind).toBe('exists')
    expect(await third.users.validateCredentials('admin', 'new-one')).not.toBeNull()
  })
})

describe('the default-password warning', () => {
  it('warns on every boot while the admin still signs in with the default — by hash', async () => {
    const rows = makeUsersTable()
    const first = await boot(rows)
    expect(first.result.usesDefaultPassword).toBe(true)
    const second = await boot(rows)
    expect(second.result.usesDefaultPassword).toBe(true)
    const warned = second.log.warn.mock.calls.map((c) => JSON.stringify(c))
    expect(warned.some((line) => line.includes('default password'))).toBe(true)
    expect(warned.some((line) => line.includes('changeme'))).toBe(false)
  })

  it('stops warning once the password was changed', async () => {
    const rows = makeUsersTable()
    const first = await boot(rows)
    const admin = await first.users.findByUsername('admin')
    if (!admin) throw new Error('admin not seeded')
    await first.users.resetPassword(admin.id, 'operator-chosen')
    const second = await boot(rows)
    expect(second.result.usesDefaultPassword).toBe(false)
    expect(second.log.warn).not.toHaveBeenCalled()
  })
})
