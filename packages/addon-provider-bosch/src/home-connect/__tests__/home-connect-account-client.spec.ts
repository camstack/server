import { describe, expect, it } from 'vitest'
import { accountClient } from '../home-connect-account-client.js'
import { makeFakeClient } from './fake-client.js'

describe('accountClient', () => {
  it('lists every appliance and sends a command to that appliance only', async () => {
    const calls: string[] = []
    const client = accountClient(
      [
        {
          haId: 'A',
          name: 'Sala',
          type: 'Dishwasher',
          connection: { host: 'a', psk: 'k', mode: 'AES', iv64: '', deviceDescription: '{}' },
        },
        {
          haId: 'B',
          name: 'Kitchen',
          type: 'Dishwasher',
          connection: { host: 'b', psk: 'k', mode: 'AES', iv64: '', deviceDescription: '{}' },
        },
      ],
      (config) =>
        makeFakeClient({
          setFeature: async (haId, key) => {
            calls.push(`${config.host}:${haId}:${key}`)
          },
        }),
    )

    expect(client.getAppliances().map((app) => app.haId)).toEqual(['A', 'B'])
    await client.setFeature('B', 'BSH.Common.Command.AbortProgram', true)
    expect(calls).toEqual(['b:B:BSH.Common.Command.AbortProgram'])
  })

  it('forwards the link state of each appliance, tagged with its haId', () => {
    const children = new Map<string, ReturnType<typeof makeFakeClient>>()
    const client = accountClient(
      [
        {
          haId: 'A',
          name: 'Sala',
          type: 'Dishwasher',
          connection: { host: 'a', psk: 'k', mode: 'AES', iv64: '', deviceDescription: '{}' },
        },
      ],
      (config) => {
        const child = makeFakeClient()
        children.set(config.host, child)
        return child
      },
    )
    const seen: string[] = []
    client.onLinkChange((haId, state) => seen.push(`${haId}:${state}`))
    children.get('a')?.emitLink('A', 'disconnected')
    expect(seen).toEqual(['A:disconnected'])
    expect(client.getLinkState('A')).toBe('disconnected')
  })
})
