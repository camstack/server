import { describe, expect, it, vi } from 'vitest'
import {
  formatCertificateForRegistration,
  generateSelfSignedRegistrationMaterial,
} from '../shc-self-signed.js'
import { privateKeyParses } from '../shc-pkcs10-csr.js'
import {
  registerShcClient,
  SHC_PASSWORD_USER_ERROR,
  SHC_REGISTRATION_USER_ERROR,
  type ShcRegistrationHeaders,
  type ShcRegistrationPostBody,
  type ShcRegistrationPostResult,
} from '../shc-register.js'

const material = {
  privateKeyPem: '-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n',
  certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
}

describe('registerShcClient', () => {
  it('generates a real self-signed certificate', () => {
    const generated = generateSelfSignedRegistrationMaterial('oss_camstack')
    expect(generated.certificatePem).toContain('BEGIN CERTIFICATE')
    expect(generated.certificatePem).not.toContain('CERTIFICATE REQUEST')
    expect(privateKeyParses(generated.privateKeyPem)).toBe(true)
    const formatted = formatCertificateForRegistration(generated.certificatePem)
    expect(formatted.startsWith('-----BEGIN CERTIFICATE-----\r')).toBe(true)
    expect(formatted.endsWith('\r-----END CERTIFICATE-----')).toBe(true)
    expect(formatted.includes('\n')).toBe(false)
  })

  it('sends the system password and stores the issued token with our certificate', async () => {
    const post = vi.fn(
      async (
        _url: string,
        body: ShcRegistrationPostBody,
        headers: ShcRegistrationHeaders,
      ): Promise<ShcRegistrationPostResult> => {
        expect(body['@type']).toBe('client')
        expect(body.name).toBe('oss_CamStack_Binding')
        expect(body.primaryRole).toBe('ROLE_RESTRICTED_CLIENT')
        expect(body.certificate).toBe(
          '-----BEGIN CERTIFICATE-----\rMIIB\r-----END CERTIFICATE-----',
        )
        expect(headers.Systempassword).toBe(Buffer.from('app-secret', 'utf8').toString('base64'))
        return {
          statusCode: 201,
          bodyText: JSON.stringify({ token: 'issued-token:aa-bb' }),
        }
      },
    )
    const result = await registerShcClient({
      host: '192.168.1.59',
      systemPassword: 'app-secret',
      post,
      generateMaterial: () => material,
    })
    expect(result.sslCertificate).toBe(material.certificatePem)
    expect(result.sslKey).toBe(material.privateKeyPem)
    expect(result.token).toBe('issued-token:aa-bb')
    expect(post).toHaveBeenCalledOnce()
  })

  it('says the password was refused on HTTP 401', async () => {
    await expect(
      registerShcClient({
        host: '192.168.1.59',
        systemPassword: 'wrong',
        post: async () => ({ statusCode: 401, bodyText: '' }),
        generateMaterial: () => material,
      }),
    ).rejects.toThrow(SHC_PASSWORD_USER_ERROR)
  })

  it('refuses when the controller answers non-2xx', async () => {
    await expect(
      registerShcClient({
        host: '192.0.2.20',
        systemPassword: 'app-secret',
        post: async () => ({ statusCode: 403, bodyText: '{}' }),
        generateMaterial: () => material,
      }),
    ).rejects.toThrow(SHC_REGISTRATION_USER_ERROR)
  })

  it('refuses when the response has no token', async () => {
    await expect(
      registerShcClient({
        host: 'shc.local',
        systemPassword: 'app-secret',
        post: async () => ({ statusCode: 200, bodyText: '{"@type":"client"}' }),
        generateMaterial: () => material,
      }),
    ).rejects.toThrow(SHC_REGISTRATION_USER_ERROR)
  })
})
