import { describe, expect, it, vi } from 'vitest'
import {
  createPackageDocsReader,
  type PackageDocsClient,
  type RegistryFetch,
  type TarballFetch,
} from '../package-docs.js'

const NAME = '@camstack/addon-example'
const TARBALL = 'https://registry.example/addon-example-1.2.0.tgz'

function packument(readme: string): RegistryFetch {
  return {
    ok: true,
    body: {
      readme,
      'dist-tags': { latest: '1.2.0' },
      versions: {
        '1.2.0': {
          readme,
          dist: { tarball: TARBALL },
        },
        '1.0.0': {
          readme: 'old readme',
          deprecated: 'please use latest',
          dist: { tarball: 'https://registry.example/addon-example-1.0.0.tgz' },
        },
      },
    },
  }
}

function client(overrides: Partial<PackageDocsClient> = {}) {
  return {
    fetchPackument: vi.fn(
      async (): Promise<RegistryFetch> => packument('# Example\n\nIt lists devices.'),
    ),
    fetchTarball: vi.fn(
      async (): Promise<TarballFetch> => ({ ok: true, bytes: Buffer.from('tgz') }),
    ),
    readChangelog: vi.fn(
      async (): Promise<string | null> => '# Changelog\n\n## 1.2.0\n\n- Added listing.\n',
    ),
    ...overrides,
  }
}

describe('package docs', () => {
  it('returns the packument readme and the tarball changelog, and caches them', async () => {
    const api = client()
    const reader = createPackageDocsReader({ client: api, now: () => 1_000, ttlMs: 50 })

    const first = await reader.load(NAME)
    const second = await reader.load(NAME)

    expect(first).toEqual({
      name: NAME,
      version: '1.2.0',
      readme: { status: 'ok', markdown: '# Example\n\nIt lists devices.' },
      changelog: { status: 'ok', markdown: '# Changelog\n\n## 1.2.0\n\n- Added listing.\n' },
    })
    expect(second).toEqual(first)
    expect(api.fetchPackument).toHaveBeenCalledTimes(1)
    expect(api.fetchTarball).toHaveBeenCalledTimes(1)
    expect(api.fetchTarball).toHaveBeenCalledWith(TARBALL)
  })

  it('reports a missing changelog when the tarball has no CHANGELOG.md', async () => {
    const api = client({ readChangelog: vi.fn(async () => null) })
    const reader = createPackageDocsReader({ client: api, now: () => 1_000 })

    const docs = await reader.load(NAME, '1.2.0')

    expect(docs.readme.status).toBe('ok')
    expect(docs.changelog).toEqual({ status: 'missing' })
  })

  it('reports a registry error as a typed error, not an empty document', async () => {
    const api = client({
      fetchPackument: vi.fn(
        async (): Promise<RegistryFetch> => ({
          ok: false,
          message: 'registry GET @camstack/addon-example → 503',
        }),
      ),
    })
    const reader = createPackageDocsReader({ client: api, now: () => 1_000 })

    const docs = await reader.load(NAME)

    expect(docs.readme).toEqual({
      status: 'error',
      message: 'registry GET @camstack/addon-example → 503',
    })
    expect(docs.changelog).toEqual(docs.readme)
    expect(docs.readme).not.toEqual({ status: 'ok', markdown: '' })
    expect(api.fetchTarball).not.toHaveBeenCalled()
  })

  it('does not cache a registry error, so the next read tries again', async () => {
    const api = client({
      fetchPackument: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, message: 'registry down' } satisfies RegistryFetch)
        .mockImplementation(async () => packument('# Back\n')),
    })
    const reader = createPackageDocsReader({ client: api, now: () => 1_000 })

    const failed = await reader.load(NAME)
    const recovered = await reader.load(NAME)

    expect(failed.readme.status).toBe('error')
    expect(recovered.readme).toEqual({ status: 'ok', markdown: '# Back\n' })
    expect(api.fetchPackument).toHaveBeenCalledTimes(2)
  })

  it('reads the requested version, not latest, including a deprecated one', async () => {
    const api = client()
    const reader = createPackageDocsReader({ client: api, now: () => 1_000 })

    const docs = await reader.load(NAME, '1.0.0')

    expect(docs.version).toBe('1.0.0')
    expect(docs.readme).toEqual({ status: 'ok', markdown: 'old readme' })
    expect(api.fetchTarball).toHaveBeenCalledWith(
      'https://registry.example/addon-example-1.0.0.tgz',
    )
  })
})
