/**
 * The `storage` cap's BYTE surface is admin-only (D634, review H1).
 *
 * `storage.list` / `read` / `beginDownload` + `readChunk` were `protected`
 * with the `view` flavour on `category:system` — which every role carries. A
 * viewer could list the `backups` location and download an archive, and every
 * archive holds the live settings database, notifier tokens and all:
 *
 *   storage.list({ location: 'backups' })
 *   storage.read({ location: 'backups', relativePath: '<id>.tar.gz' })
 *
 * Why the WHOLE byte surface and not a location-class gate that lets media
 * through: no client reads media through this cap. The viewer, the admin UI,
 * the CLI and the Home Assistant components call none of these methods; media
 * reaches a person through the device-scoped caps (recordings, event media,
 * the data plane), and the one hub route that streams through
 * `beginDownload` (`/api/backup/download`) checks admin itself and calls the
 * provider in-process. A media location opened to non-admins here would ALSO
 * bypass device scoping — `storage.read({ location: 'recordings' })` names no
 * device, so a viewer granted one camera would read every camera's footage.
 * Addons are unaffected: their `ctx.api` cap calls never enter this router.
 *
 * The location metadata (`listLocations`, redacted by the orchestrator) and
 * `getAvailableSpace` (a number) stay open.
 */
import type { CapabilityDefinition } from '@camstack/types'
import {
  ACCESS_ROLES,
  buildRoleScopes,
  type CapabilityMethodSchema,
  type IStorageCapProvider,
  resolveMethodAuth,
  storageCapability,
  type TokenScope,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

/** Widened the way the router builder sees each cap — `resolveMethodAuth` reads only `internal`. */
const storageDef: CapabilityDefinition = storageCapability

/** Every method that reads, writes, lists or resolves a path inside a location. */
const BYTE_METHODS: readonly string[] = [
  'resolve',
  'write',
  'read',
  'exists',
  'list',
  'delete',
  'beginUpload',
  'writeChunk',
  'finalizeUpload',
  'abortUpload',
  'beginDownload',
  'readChunk',
  'endDownload',
]

/** A backup archive (settings DB inside) and a media location. */
const LOCATIONS: readonly string[] = ['backups', 'recordings']

const ARCHIVE_BYTES = new Uint8Array([0x1f, 0x8b, 0x08])

function roleScopes(roleId: (typeof ACCESS_ROLES)[number]['id']): readonly TokenScope[] {
  return buildRoleScopes({ roleId, selector: { kind: 'all' }, includeLinked: true })
}

function storageProvider(): IStorageCapProvider {
  return {
    resolve: async () => '/data/backups/x.tar.gz',
    write: async () => undefined,
    read: async () => ARCHIVE_BYTES,
    exists: async () => true,
    list: async () => ['2026-09-25.tar.gz'],
    delete: async () => undefined,
    getAvailableSpace: async () => 1024,
    beginUpload: async () => ({ uploadId: 'u1' }),
    writeChunk: async () => undefined,
    finalizeUpload: async () => undefined,
    abortUpload: async () => undefined,
    beginDownload: async () => ({ downloadId: 'd1', sizeBytes: 3 }),
    readChunk: async () => ARCHIVE_BYTES,
    endDownload: async () => undefined,
    listLocations: async () => [],
    listLocationDeclarations: async () => [],
    upsertLocation: async () => {
      throw new Error('not used')
    },
    deleteLocation: async () => undefined,
    listDrainProgress: async () => [],
    testLocation: async () => ({ ok: true }),
    listProviders: async () => [],
    testConfig: async () => ({ ok: true }),
  }
}

/** An input valid for every byte method at once (extra keys are loose). */
function inputFor(location: string): Record<string, unknown> {
  return {
    location,
    relativePath: '2026-09-25.tar.gz',
    prefix: '',
    data: ARCHIVE_BYTES,
    uploadId: 'u1',
    downloadId: 'd1',
    offset: 0,
    length: 3,
  }
}

describe('storage byte methods: tier', () => {
  it('every byte method resolves to admin', () => {
    const methods: Readonly<Record<string, CapabilityMethodSchema>> = storageCapability.methods
    for (const name of BYTE_METHODS) {
      const schema = methods[name]
      if (schema === undefined) throw new Error(`storage.${name} no longer exists`)
      expect(resolveMethodAuth(storageDef, schema), `storage.${name}`).toBe('admin')
    }
  })

  it('the redacted location list and the free-space number stay open', () => {
    expect(resolveMethodAuth(storageDef, storageCapability.methods.listLocations)).toBe('protected')
    expect(resolveMethodAuth(storageDef, storageCapability.methods.getAvailableSpace)).toBe(
      'protected',
    )
  })
})

describe('storage byte methods: live router', () => {
  it('refuses viewer, operator and manager on backups AND on media, with the tier message', async () => {
    const router = buildCapRouterForTest('storage', () => storageProvider())
    for (const roleId of ACCESS_ROLES.map((r) => r.id)) {
      const ctx = makeCtx('user', { scopes: roleScopes(roleId) })
      for (const location of LOCATIONS) {
        for (const method of BYTE_METHODS) {
          const result = await invokeProcedure(router, method, ctx, inputFor(location))
          expect(result.ok, `${roleId} reached storage.${method}(${location})`).toBe(false)
          if (!result.ok) {
            expect(result.code, `${roleId} storage.${method}`).toBe('FORBIDDEN')
            expect(result.message).toBe('Admin required')
          }
        }
      }
    }
  })

  it('serves an admin on both, and a viewer still lists locations', async () => {
    const router = buildCapRouterForTest('storage', () => storageProvider())
    for (const location of LOCATIONS) {
      const listed = await invokeProcedure(router, 'list', makeCtx('admin'), { location })
      expect(listed.ok, `admin list ${location}`).toBe(true)
      const read = await invokeProcedure(router, 'read', makeCtx('admin'), {
        location,
        relativePath: '2026-09-25.tar.gz',
      })
      expect(read.ok, `admin read ${location}`).toBe(true)
    }
    const viewer = makeCtx('user', { scopes: roleScopes('viewer') })
    const locations = await invokeProcedure(router, 'listLocations', viewer, {})
    expect(locations.ok).toBe(true)
  })
})
