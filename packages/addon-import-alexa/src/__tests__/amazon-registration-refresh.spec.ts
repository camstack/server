import { describe, expect, it } from 'vitest'
import { AmazonAuthRejectedError } from '../amazon-auth/http.js'
import { RegisterSuccessSchema, completeRegistration } from '../amazon-auth/register-device.js'
import {
  AlexaRegistrationSeedSchema,
  REGISTRATION_DATA_VERSION,
  parseRegistration,
  refreshRegistration,
} from '../amazon-auth/registration.js'
import { exchangeForCookies, fetchAccessToken } from '../amazon-auth/token-exchange.js'
import { fakeAmazon, fixtureJson, refreshRoutes } from './helpers/amazon-fake.js'

const seed = {
  refreshToken: 'FIXTURE-REFRESH-TOKEN',
  loginCookie: 'frc=FRC; map-md=MAPMD; session-id=OLD',
  deviceSerial: 'SERIAL',
  amazonPage: 'amazon.it',
  deviceId: 'DEV',
  macDms: { adp_token: 'FIXTURE-ADP-TOKEN' },
  deviceAppName: 'CamStack',
  frc: 'FRC',
  'map-md': 'MAPMD',
} as const

describe('renewing a registration', () => {
  it('produces exactly the dataVersion-2 blob the remote library stores', async () => {
    const amazon = fakeAmazon(refreshRoutes())
    const next = await refreshRegistration(seed, amazon.http, { now: () => 1_700_000_000_000 })
    expect(next).toEqual({
      ...seed,
      accessToken: 'FIXTURE-REFRESHED-ACCESS-TOKEN',
      loginCookie:
        'frc=FRC; map-md=MAPMD; session-id=FIXTURE-EXCHANGED-SESSION; session-token=FIXTURE-EXCHANGED-TOKEN; at-acbit=FIXTURE-EXCHANGED-AT',
      localCookie: expect.stringContaining('csrf=FIXTURE-CSRF'),
      csrf: 'FIXTURE-CSRF',
      tokenDate: 1_700_000_000_000,
      dataVersion: REGISTRATION_DATA_VERSION,
    })
    // the login cookie is allow-listed; the website cookie is the exchange's own jar, as before
    expect(next.loginCookie).not.toContain('tracking-junk')
    expect(parseRegistration(JSON.stringify(next))).toEqual(next)
  })

  it('refreshes a legacy blob without deviceAppName under the legacy name', async () => {
    const amazon = fakeAmazon(refreshRoutes())
    const { deviceAppName: _drop, ...legacy } = seed
    const next = await refreshRegistration(legacy, amazon.http)
    expect(next.deviceAppName).toBe('ioBroker Alexa2')
    expect(amazon.callsTo('POST api.amazon.it/auth/token')[0]?.body).toContain('ioBroker')
  })

  it.each([400, 401, 403])('maps a %i from the token endpoint to a rejection', async (status) => {
    const amazon = fakeAmazon({ 'POST api.amazon.it/auth/token': { status, json: {} } })
    await expect(refreshRegistration(seed, amazon.http)).rejects.toBeInstanceOf(
      AmazonAuthRejectedError,
    )
  })

  it('keeps a 5xx a plain retryable error, not a rejection', async () => {
    const amazon = fakeAmazon({ 'POST api.amazon.it/auth/token': { status: 503, json: {} } })
    const err = await refreshRegistration(seed, amazon.http).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(AmazonAuthRejectedError)
  })

  it('maps a refused cookie exchange to a rejection', async () => {
    const amazon = fakeAmazon({
      ...refreshRoutes(),
      'POST www.amazon.it/ap/exchangetoken/cookies': { status: 401, json: {} },
    })
    await expect(refreshRegistration(seed, amazon.http)).rejects.toBeInstanceOf(
      AmazonAuthRejectedError,
    )
  })

  it('still renews when the capabilities announcement fails', async () => {
    const amazon = fakeAmazon({
      ...refreshRoutes(),
      'PUT api.amazonalexa.com/v1/devices/@self/capabilities': { status: 500 },
    })
    await expect(refreshRegistration(seed, amazon.http)).resolves.toMatchObject({
      csrf: 'FIXTURE-CSRF',
    })
  })

  it('rejects a stored blob that is not a registration', () => {
    expect(parseRegistration('not json')).toBeNull()
    expect(parseRegistration({ refreshToken: 'x' })).toBeNull()
  })
})

describe('token and cookie exchange primitives', () => {
  it('sends the refresh token as source_token in a form body', async () => {
    const amazon = fakeAmazon(refreshRoutes())
    const token = await fetchAccessToken(
      {
        amazonPage: 'amazon.it',
        refreshToken: 'RT',
        loginCookie: 'a=b',
        deviceAppName: 'CamStack',
        acceptLanguage: 'it-IT',
      },
      amazon.http,
    )
    expect(token).toBe('FIXTURE-REFRESHED-ACCESS-TOKEN')
    const req = amazon.calls[0]
    expect(req?.body).toContain('source_token=RT')
    expect(req?.headers['Accept-Language']).toBe('it-IT')
  })

  it('returns every cookie of the exchange as the website jar', async () => {
    const amazon = fakeAmazon(refreshRoutes())
    const jar = await exchangeForCookies(
      {
        amazonPage: 'amazon.it',
        refreshToken: 'RT',
        deviceAppName: 'CamStack',
        acceptLanguage: 'en-US',
      },
      amazon.http,
    )
    expect(jar).toContain('session-id=FIXTURE-EXCHANGED-SESSION')
    expect(jar).toContain('at-acbit=FIXTURE-EXCHANGED-AT')
  })
})

describe('completing a registration', () => {
  const tokens = {
    bearer: { refresh_token: 'FIXTURE-REFRESH-TOKEN' },
    website_cookies: [{ Name: 'session-id', Value: 'FIXTURE-REGISTER-SESSION' }],
    mac_dms: { adp_token: 'FIXTURE-ADP-TOKEN' },
  }

  it('follows the marketplace page the account lives on and records the app name', async () => {
    const amazon = fakeAmazon({
      ...refreshRoutes(),
      'GET alexa.amazon.it/api/users/me?platform=ios&version=2.2.651540.0': {
        json: fixtureJson('users-me.json'),
      },
    })
    const blob = await completeRegistration(
      tokens,
      { amazonPage: 'amazon.it', deviceSerial: 'S', frc: 'FRC', mapMd: 'MAPMD' },
      amazon.http,
    )
    expect(blob).toMatchObject({
      amazonPage: 'amazon.it',
      deviceAppName: 'CamStack',
      refreshToken: 'FIXTURE-REFRESH-TOKEN',
      dataVersion: 2,
    })
    expect(blob.macDms).toEqual({ adp_token: 'FIXTURE-ADP-TOKEN' })
  })

  it('falls back to the sign-in page when the lookup fails', async () => {
    const amazon = fakeAmazon(refreshRoutes())
    const blob = await completeRegistration(
      tokens,
      { amazonPage: 'amazon.it', deviceSerial: 'S', frc: 'FRC', mapMd: 'MAPMD' },
      amazon.http,
    )
    expect(blob.amazonPage).toBe('amazon.it')
  })
})

describe('cookie values and redirects', () => {
  it('round-trips a quoted value and an escaped semicolon untouched', async () => {
    const amazon = fakeAmazon(refreshRoutes())
    const next = await refreshRegistration(
      { ...seed, loginCookie: 'frc=F%3BG; map-md="quoted=="; session-id=OLD' },
      amazon.http,
    )
    expect(next.loginCookie).toContain('frc=F%3BG')
    expect(next.loginCookie).toContain('map-md="quoted=="')
  })

  it('refuses to carry the cookies to a redirect outside the account domain', async () => {
    const amazon = fakeAmazon({
      ...refreshRoutes(),
      'GET alexa.amazon.it/api/language': {
        status: 302,
        location: 'https://evil.example.com/steal',
      },
    })
    await expect(refreshRegistration(seed, amazon.http)).rejects.toThrow()
    expect(amazon.calls.filter((c) => c.host === 'evil.example.com')).toHaveLength(0)
  })

  it('follows a redirect inside the account domain', async () => {
    const amazon = fakeAmazon({
      ...refreshRoutes(),
      'GET alexa.amazon.it/api/language': { status: 302, location: 'https://www.amazon.it/hop' },
      'GET www.amazon.it/hop': { setCookies: ['csrf=FIXTURE-CSRF; Path=/'] },
    })
    await expect(refreshRegistration(seed, amazon.http)).resolves.toMatchObject({
      csrf: 'FIXTURE-CSRF',
    })
  })
})

describe('registration secrecy', () => {
  it('marks the device key material secret', () => {
    expect(AlexaRegistrationSeedSchema.shape.macDms.meta()).toMatchObject({ secret: true })
    expect(
      RegisterSuccessSchema.shape.response.shape.success.shape.tokens.shape.mac_dms.meta(),
    ).toMatchObject({ secret: true })
  })
})
