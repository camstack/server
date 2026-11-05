import { describe, expect, it } from 'vitest'
import { buildRegisterBody, registerDevice } from '../amazon-auth/register-device.js'
import { fakeAmazon, fixtureJson } from './helpers/amazon-fake.js'

const base = { amazonPage: 'amazon.it', deviceSerial: 'SERIAL', frc: 'FRC' }
const code = {
  kind: 'authorization-code',
  authorizationCode: 'CODE',
  codeVerifier: 'VER',
  deviceId: 'DEV',
} as const

describe('device registration', () => {
  it('sends the authorization-code body', () => {
    const body = JSON.parse(buildRegisterBody({ ...base, auth: code }))
    expect(body.auth_data).toEqual({
      client_id: 'DEV',
      authorization_code: 'CODE',
      code_verifier: 'VER',
      code_algorithm: 'SHA-256',
      client_domain: 'DeviceLegacy',
    })
    expect(body.cookies.domain).toBe('.amazon.it')
    expect(body.user_context_map).toEqual({ frc: 'FRC' })
    expect(body.registration_data.app_name).toBe('CamStack')
    expect(body.requested_token_type).toEqual(['bearer', 'mac_dms', 'website_cookies'])
  })

  it('sends the code-pair body for the device-code flow', () => {
    const body = JSON.parse(
      buildRegisterBody({
        ...base,
        auth: { kind: 'code-pair', publicCode: 'PUB', privateCode: 'PRIV' },
      }),
    )
    expect(body.auth_data).toEqual({
      code_pair: { public_code: 'PUB', private_code: 'PRIV' },
      use_global_authentication: 'true',
    })
  })

  it('returns the tokens on success', async () => {
    const amazon = fakeAmazon({
      'POST api.amazon.it/auth/register': { json: fixtureJson('register-success.json') },
    })
    const out = await registerDevice({ ...base, auth: code }, amazon.http)
    expect(out.kind).toBe('registered')
    if (out.kind === 'registered') {
      expect(out.tokens.bearer.refresh_token).toBe('FIXTURE-REFRESH-TOKEN')
      expect(out.tokens.website_cookies).toHaveLength(2)
    }
  })

  it.each([
    ['register-401.json', 401, 'Unauthorized'],
    ['register-error.json', 400, 'InvalidRequest'],
  ])('reports a refusal by status and code only (%s)', async (file, status, expected) => {
    const amazon = fakeAmazon({
      'POST api.amazon.it/auth/register': { status, json: fixtureJson(file) },
    })
    const out = await registerDevice({ ...base, auth: code }, amazon.http)
    expect(out).toEqual({ kind: 'refused', status, code: expected })
    expect(JSON.stringify(out)).not.toContain('FIXTURE-DO-NOT-ECHO')
  })

  it('treats a 200 without tokens as a refusal', async () => {
    const amazon = fakeAmazon({ 'POST api.amazon.it/auth/register': { json: { response: {} } } })
    const out = await registerDevice({ ...base, auth: code }, amazon.http)
    expect(out.kind).toBe('refused')
  })
})
