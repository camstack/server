import { describe, expect, it } from 'vitest'
import type { LoginProxyResponseView } from '@camstack/types'
import { AmazonLoginAttempt, amazonUpstreams } from '../amazon-auth/login-attempt.js'
import { FIXTURE_SECRETS, fixtureText } from './helpers/amazon-fake.js'
import { recordingLogger } from './helpers/recording-logger.js'

function view(over: Partial<LoginProxyResponseView>): LoginProxyResponseView {
  return {
    status: 200,
    url: 'https://www.amazon.it/ap/signin',
    location: null,
    setCookies: [],
    bodyText: null,
    ...over,
  }
}

function attempt() {
  const rec = recordingLogger()
  const a = new AmazonLoginAttempt({
    amazonDomain: 'amazon.it',
    sessionId: 'sess-1',
    logger: rec.logger,
    randomBytes: (size) => Buffer.alloc(size, 7),
  })
  return { a, rec }
}

describe('an Amazon sign-in attempt', () => {
  it('dials Amazon directly, never a loopback helper', () => {
    expect(amazonUpstreams('amazon.it').map((u) => u.host)).toEqual([
      'www.amazon.it',
      'amazon.it',
      'alexa.amazon.it',
      'www.amazon.com',
      'amazon.com',
    ])
    expect(amazonUpstreams('amazon.com').map((u) => u.host)).toEqual([
      'www.amazon.com',
      'amazon.com',
      'alexa.amazon.com',
    ])
    expect(amazonUpstreams('amazon.it').every((u) => u.scheme === 'https')).toBe(true)
  })

  it('starts from the oa2 sign-in URL of its own secrets', () => {
    const { a } = attempt()
    const url = new URL(a.signInUrl)
    expect(url.host).toBe('www.amazon.it')
    expect(url.searchParams.get('openid.oa2.client_id')).toBe(`device:${a.secrets.deviceId}`)
    expect(url.searchParams.get('language')).toBe('it_IT')
  })

  describe('verdict', () => {
    it.each([
      ['an ordinary sign-in page', view({ status: 200 })],
      ['the identifier-first claim page', view({ url: 'https://www.amazon.it/ax/claim?x=1' })],
      ['the verification page', view({ url: 'https://www.amazon.it/ap/cvf/request' })],
      [
        'a redirect to another sign-in step',
        view({
          status: 302,
          location: 'https://www.amazon.it/ap/signin?openid.mode=checkid_setup',
        }),
      ],
    ])('continues on %s', (_name, v) => {
      expect(attempt().a.terminal(v)).toEqual({ kind: 'continue' })
    })

    it('is done with the code when maplanding carries it (as the Location)', () => {
      const { a } = attempt()
      expect(
        a.terminal(view({ status: 302, location: fixtureText('maplanding-with-code.url') })),
      ).toEqual({
        kind: 'done',
        payload: { kind: 'authorized', authorizationCode: 'FIXTURE-AUTH-CODE' },
      })
    })

    it('is done with the code when maplanding is the request itself', () => {
      const { a } = attempt()
      expect(a.terminal(view({ url: fixtureText('maplanding-with-code.url') }))).toEqual({
        kind: 'done',
        payload: { kind: 'authorized', authorizationCode: 'FIXTURE-AUTH-CODE' },
      })
    })

    it('resolves a relative Location against the request', () => {
      const { a } = attempt()
      expect(
        a.terminal(
          view({
            status: 302,
            location: '/ap/maplanding?openid.oa2.authorization_code=FIXTURE-AUTH-CODE',
          }),
        ),
      ).toEqual({
        kind: 'done',
        payload: { kind: 'authorized', authorizationCode: 'FIXTURE-AUTH-CODE' },
      })
    })

    it('ends at once as no_authorization_code when maplanding has none', () => {
      const { a } = attempt()
      expect(
        a.terminal(view({ status: 302, location: fixtureText('maplanding-without-code.url') })),
      ).toEqual({ kind: 'done', payload: { kind: 'no_authorization_code' } })
    })

    it('treats an empty code as none', () => {
      const { a } = attempt()
      expect(
        a.terminal(
          view({ location: 'https://www.amazon.it/ap/maplanding?openid.oa2.authorization_code=' }),
        ),
      ).toEqual({ kind: 'done', payload: { kind: 'no_authorization_code' } })
    })
  })

  describe('cookies', () => {
    it('keeps only allow-listed cookies, with the latest value of each', () => {
      const { a } = attempt()
      a.terminal(
        view({
          setCookies: [
            'session-id=ONE; Path=/; Secure',
            'ubid-acbit=UBID; Path=/',
            'tracking-junk=DROP; Path=/',
            'ap-fid=""; Path=/',
          ],
        }),
      )
      a.terminal(view({ setCookies: ['session-id=TWO; Path=/'] }))
      expect(a.signInCookie).toBe('session-id=TWO; ubid-acbit=UBID')
    })

    it('collects the cookies of the response that carries the final redirect', () => {
      const { a } = attempt()
      a.terminal(
        view({
          status: 302,
          location: fixtureText('maplanding-with-code.url'),
          setCookies: ['at-acbit=FINAL; Path=/'],
        }),
      )
      expect(a.signInCookie).toContain('at-acbit=FINAL')
    })
  })

  it('logs paths and parameter names, never the code or a cookie value', () => {
    const { a, rec } = attempt()
    a.terminal(view({ setCookies: ['session-id=FIXTURE-REGISTER-SESSION; Path=/'] }))
    a.terminal(
      view({
        status: 302,
        url: 'https://www.amazon.it/ap/cvf/verify?openid.sig=FIXTURE-SIG',
        location: fixtureText('maplanding-with-code.url'),
        setCookies: ['at-acbit=FIXTURE-EXCHANGED-TOKEN; Path=/'],
      }),
    )
    const dump = rec.dump()
    expect(rec.lines.length).toBeGreaterThan(0)
    expect(dump).toContain('openid.oa2.authorization_code')
    for (const secret of [...FIXTURE_SECRETS, 'FIXTURE-SIG']) expect(dump).not.toContain(secret)
  })
})
