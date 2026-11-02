/**
 * The hub's public URL is the `publicEndpoint` role of the local-network palette,
 * read on every use: no setting, no cached copy (D986 §5).
 */
import { describe, expect, it } from 'vitest'
import {
  buildConsoleSetupFromRole,
  NO_PUBLIC_ENDPOINT_REASON,
  type PublicEndpointAnswer,
} from '../public-endpoint.js'

const book = (resolved: string | null): PublicEndpointAnswer => ({
  roles: { publicEndpoint: { resolved } },
})

const rowValue = (rows: readonly { label: string; value: string }[] | undefined, label: string) =>
  (rows ?? []).find((r) => r.label === label)?.value

describe('buildConsoleSetupFromRole', () => {
  it('renders the three console URLs from the role, and follows it with no restart', async () => {
    let current = book('https://one.example.org/')
    const read = async () => current
    const first = await buildConsoleSetupFromRole({
      addonId: 'export-google',
      linkedAccounts: 0,
      read,
    })
    expect(rowValue(first.fields, 'Fulfillment URL')).toBe(
      'https://one.example.org/addon/export-google/fulfillment',
    )
    expect(rowValue(first.fields, 'Token URL')).toBe('https://one.example.org/api/oauth2/token')

    current = book('https://two.example.org')
    const second = await buildConsoleSetupFromRole({
      addonId: 'export-google',
      linkedAccounts: 0,
      read,
    })
    expect(rowValue(second.fields, 'Fulfillment URL')).toBe(
      'https://two.example.org/addon/export-google/fulfillment',
    )
    expect(rowValue(second.fields, 'Authorization URL')).toBe(
      'https://two.example.org/api/oauth2/authorize?integration=export-google',
    )
  })

  it('refuses with a typed reason naming the Network page when the role resolves to nothing', async () => {
    const setup = await buildConsoleSetupFromRole({
      addonId: 'export-google',
      linkedAccounts: 2,
      read: async () => book(null),
    })
    expect((setup.fields ?? []).map((f) => f.label)).toEqual(['Linked Google accounts'])
    expect(setup.note).toContain(NO_PUBLIC_ENDPOINT_REASON.code)
    expect(setup.note).toContain('Network page')
    expect(setup.note).not.toMatch(/localhost|127\.0\.0\.1/)
  })

  it('refuses the same way when the address book cannot be read', async () => {
    const setup = await buildConsoleSetupFromRole({
      addonId: 'export-google',
      linkedAccounts: 0,
      read: async () => {
        throw new Error('hub unreachable')
      },
    })
    expect(setup.note).toContain(NO_PUBLIC_ENDPOINT_REASON.code)
    expect((setup.fields ?? []).map((f) => f.label)).toEqual(['Linked Google accounts'])
  })
})
