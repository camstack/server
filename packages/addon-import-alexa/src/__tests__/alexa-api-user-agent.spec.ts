import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'

const initCalls: Array<Record<string, unknown>> = []

vi.mock('alexa-remote2', () => ({
  default: class {
    on(): void {}
    init(options: Record<string, unknown>): void {
      initCalls.push(options)
    }
    stop(): void {}
  },
}))

const { AlexaProxyLoginSession } = await import('../alexa-proxy-login.js')
const { ALEXA_API_USER_AGENT_POSTFIX } = await import('../alexa-api-user-agent.js')

describe('alexa-remote2 init gets apiUserAgentPostfix', () => {
  it('is the library name and version', () => {
    expect(ALEXA_API_USER_AGENT_POSTFIX).toMatch(/^AlexaRemote\/\d+\.\d+\.\d+$/)
  })

  it('proxy login passes it, so the library never reads its own package.json', async () => {
    const logger: IScopedLogger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return logger
      },
      withTags() {
        return logger
      },
    }
    const session = new AlexaProxyLoginSession({
      sessionId: 's1',
      amazonDomain: 'amazon.it',
      loginUrl: '/addon/import-alexa/vendor-login/s1/127.0.0.1:0/',
      proxyPort: 0,
      logger,
      onCookie: () => undefined,
    })
    void session.start().catch(() => undefined)
    await new Promise((r) => setTimeout(r, 10))
    expect(initCalls[0]?.['apiUserAgentPostfix']).toBe(ALEXA_API_USER_AGENT_POSTFIX)
  })
})
