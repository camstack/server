import { describe, expect, it } from 'vitest'
import {
  BAICHUAN_WEBHOOK_URL_GENERATION,
  buildBaichuanWebhookUrl,
  resolveWebhookEndpoint,
} from '../baichuan-webhook-shared.js'
import { type ArmedHaCfg, repointWebhookOnce } from '../webhook-generation.js'

const OLD_URL = 'http://192.168.10.9:9081/webhook/mac-aa'
const NEW_URL = 'http://192.168.10.9:4480/addon/provider-reolink/webhook/mac-aa'

function device(initial: { generation?: number; haCfg?: ArmedHaCfg; failArm?: boolean }) {
  const state = { generation: initial.generation, armed: [] as string[], haCfgReads: 0 }
  return {
    state,
    ports: {
      readGeneration: () => state.generation,
      writeGeneration: async (g: number) => {
        state.generation = g
      },
      readCameraHaCfg: async () => {
        state.haCfgReads += 1
        return initial.haCfg
      },
      targetUrl: async () => NEW_URL,
      arm: async (url: string) => {
        if (initial.failArm) throw new Error('camera refused')
        state.armed.push(url)
      },
    },
  }
}

describe('buildBaichuanWebhookUrl', () => {
  it('is the data-plane URL of the addon on the LAN HTTP port', () => {
    expect(buildBaichuanWebhookUrl({ host: '192.168.10.9', port: 4480, stableId: 'mac-aa' })).toBe(
      NEW_URL,
    )
    expect(buildBaichuanWebhookUrl({ host: 'h', port: 4480, stableId: 'a/b' })).toBe(
      'http://h:4480/addon/provider-reolink/webhook/a%2Fb',
    )
  })
})

describe('resolveWebhookEndpoint', () => {
  const internal = (resolved: string | null) => ({ roles: { internal: { resolved } } })

  it('takes the host from the internal role, never from another address', () => {
    expect(
      resolveWebhookEndpoint({
        ...internal('https://10.0.0.5:4443'),
        listenerOrigins: ['https://203.0.113.7:4443', 'http://10.0.0.5:4480'],
      }),
    ).toEqual({ host: '10.0.0.5', port: 4480 })
  })

  it('uses the plain-HTTP port the hub lists, not a guess', () => {
    expect(
      resolveWebhookEndpoint({
        ...internal('https://10.0.0.5:4443'),
        listenerOrigins: ['http://10.0.0.5:4999'],
      }).port,
    ).toBe(4999)
  })

  it('refuses with the reason when there is no internal address', () => {
    expect(() => resolveWebhookEndpoint(internal(null))).toThrow(/no internal address/)
  })

  it('refuses, never falling back to HTTPS, when LAN HTTP is off', () => {
    expect(() =>
      resolveWebhookEndpoint({
        ...internal('https://10.0.0.5:4443'),
        listenerOrigins: ['https://10.0.0.5:4443'],
      }),
    ).toThrow(/LAN HTTP/)
  })
})

describe('repointWebhookOnce', () => {
  it('moves a camera armed at the retired URL, then never touches it again', async () => {
    const { ports, state } = device({ haCfg: { enable: true, url: OLD_URL } })
    expect(await repointWebhookOnce(ports)).toBe('repointed')
    expect(state.armed).toEqual([NEW_URL])
    expect(state.generation).toBe(BAICHUAN_WEBHOOK_URL_GENERATION)
    expect(await repointWebhookOnce(ports)).toBe('current')
    expect(state.armed).toEqual([NEW_URL])
    expect(state.haCfgReads).toBe(1)
  })

  it('does not arm a camera that never had a webhook (an e-mail camera stays on e-mail)', async () => {
    const { ports, state } = device({ haCfg: { enable: false, url: '' } })
    expect(await repointWebhookOnce(ports)).toBe('not-armed')
    expect(state.armed).toEqual([])
    expect(state.generation).toBe(BAICHUAN_WEBHOOK_URL_GENERATION)
  })

  it('a failed write leaves the generation unwritten so the next contact retries', async () => {
    const { ports, state } = device({ haCfg: { enable: true, url: OLD_URL }, failArm: true })
    await expect(repointWebhookOnce(ports)).rejects.toThrow('camera refused')
    expect(state.generation).toBeUndefined()
  })
})
