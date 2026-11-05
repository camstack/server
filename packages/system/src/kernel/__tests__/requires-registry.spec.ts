/**
 * Reading a package's `camstack.requires` from the registry must use the same
 * door the install uses: the plain HTTP document, then `npm` with the user's
 * npmrc (private registries, auth). A refusal for lack of auth is a read that
 * FAILED, never a minimum that was not met.
 */
import { describe, expect, it } from 'vitest'
import { createRequiresRegistry, RegistryReadError } from '../requires-registry.js'

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('createRequiresRegistry.requiresOf', () => {
  it('reads the requires from the HTTP version document', async () => {
    const registry = createRequiresRegistry({
      registry: 'https://r.example',
      fetchJson: async () => response(200, { camstack: { requires: { server: '>=1.2.0' } } }),
      npmView: async () => {
        throw new Error('npm must not be asked')
      },
    })
    expect(await registry.requiresOf('@camstack/addon-x', '1.0.0')).toEqual({ server: '>=1.2.0' })
  })

  it('falls back to npm (npmrc auth) when HTTP answers 401, and uses its answer', async () => {
    const asked: string[][] = []
    const registry = createRequiresRegistry({
      registry: 'https://r.example',
      fetchJson: async () => response(401, {}),
      npmView: async (args) => {
        asked.push([...args])
        return JSON.stringify({ server: '>=1.4.0' })
      },
    })
    expect(await registry.requiresOf('@camstack/addon-x', '1.0.0')).toEqual({ server: '>=1.4.0' })
    expect(asked[0]).toEqual(['view', '@camstack/addon-x@1.0.0', 'camstack.requires', '--json'])
  })

  it('reports an auth failure as a failed read, not as an unmet minimum', async () => {
    const registry = createRequiresRegistry({
      registry: 'https://r.example',
      fetchJson: async () => response(401, {}),
      npmView: async () => {
        throw new Error('npm error code E401')
      },
    })
    const err: unknown = await registry.requiresOf('@camstack/addon-x', '1.0.0').catch((e) => e)
    expect(err).toBeInstanceOf(RegistryReadError)
    expect(err instanceof RegistryReadError && err.kind).toBe('auth')
  })

  it('treats an npm answer with no value as "declares none"', async () => {
    const registry = createRequiresRegistry({
      registry: 'https://r.example',
      fetchJson: async () => response(404, {}),
      npmView: async () => '',
    })
    expect(await registry.requiresOf('@camstack/addon-x', '1.0.0')).toBeUndefined()
  })
})

describe('createRequiresRegistry.versions', () => {
  it('lists stable versions newest first from the packument', async () => {
    const registry = createRequiresRegistry({
      registry: 'https://r.example',
      fetchJson: async () =>
        response(200, { versions: { '1.2.0': {}, '1.10.0': {}, '1.3.0-beta.1': {}, '1.9.0': {} } }),
      npmView: async () => '[]',
    })
    expect(await registry.versions('@camstack/addon-x')).toEqual(['1.10.0', '1.9.0', '1.2.0'])
  })

  it('falls back to npm when HTTP is refused', async () => {
    const registry = createRequiresRegistry({
      registry: 'https://r.example',
      fetchJson: async () => response(403, {}),
      npmView: async () => JSON.stringify(['1.0.0', '1.1.0']),
    })
    expect(await registry.versions('@camstack/addon-x')).toEqual(['1.1.0', '1.0.0'])
  })
})
