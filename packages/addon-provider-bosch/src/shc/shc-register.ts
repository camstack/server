import { randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import {
  formatCertificateForRegistration,
  generateSelfSignedRegistrationMaterial,
} from './shc-self-signed.js'

export const SHC_REGISTRATION_USER_ERROR =
  'The controller is not in registration mode. Hold the pairing button on the device, then try again.'

export const SHC_PASSWORD_USER_ERROR =
  'The system password was refused. Use the password you set in the Bosch Smart Home app, not the code printed on the controller.'

export const SHC_PASSWORD_MISSING_ERROR =
  'Enter the system password you set in the Bosch Smart Home app.'

export interface ShcRegistrationPostBody {
  readonly '@type': 'client'
  readonly id: string
  readonly name: string
  readonly primaryRole: 'ROLE_RESTRICTED_CLIENT'
  readonly certificate: string
}

export interface ShcRegistrationHeaders {
  readonly Systempassword: string
}

export interface ShcRegistrationPostResult {
  readonly statusCode: number
  readonly bodyText: string
}

export interface RegisterShcClientDeps {
  readonly host: string
  readonly systemPassword: string
  readonly name?: string
  readonly post?: (
    url: string,
    body: ShcRegistrationPostBody,
    headers: ShcRegistrationHeaders,
  ) => Promise<ShcRegistrationPostResult>
  readonly generateMaterial?: (clientId: string) => {
    readonly privateKeyPem: string
    readonly certificatePem: string
  }
}

export interface RegisterShcClientResult {
  readonly sslCertificate: string
  readonly sslKey: string
  readonly token: string
}

function normalizeHost(host: string): string {
  let h = host.trim()
  if (h.startsWith('https://')) h = h.slice('https://'.length)
  if (h.startsWith('http://')) h = h.slice('http://'.length)
  const slash = h.indexOf('/')
  if (slash >= 0) h = h.slice(0, slash)
  return h
}

function parseRegistrationToken(bodyText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (parsed === null || typeof parsed !== 'object') return null
    const token = Reflect.get(parsed, 'token')
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

async function defaultPost(
  url: string,
  body: ShcRegistrationPostBody,
  headers: ShcRegistrationHeaders,
): Promise<ShcRegistrationPostResult> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Systempassword: headers.Systempassword,
        },
        rejectUnauthorized: false,
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            bodyText: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', () => reject(new Error(SHC_REGISTRATION_USER_ERROR)))
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(SHC_REGISTRATION_USER_ERROR))
    })
    req.write(payload)
    req.end()
  })
}

export async function registerShcClient(
  deps: RegisterShcClientDeps,
): Promise<RegisterShcClientResult> {
  const host = normalizeHost(deps.host)
  if (host.length === 0) {
    throw new Error('Enter the controller host or IP address.')
  }
  const systemPassword = deps.systemPassword.trim()
  if (systemPassword.length === 0) {
    throw new Error(SHC_PASSWORD_MISSING_ERROR)
  }
  const clientId = `oss_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const clientName = deps.name?.trim() || 'oss_CamStack_Binding'
  const generateMaterial = deps.generateMaterial ?? generateSelfSignedRegistrationMaterial
  const { privateKeyPem, certificatePem } = generateMaterial(clientId)
  const post = deps.post ?? defaultPost
  const url = `https://${host}:8443/smarthome/clients`
  const body: ShcRegistrationPostBody = {
    '@type': 'client',
    id: clientId,
    name: clientName,
    primaryRole: 'ROLE_RESTRICTED_CLIENT',
    certificate: formatCertificateForRegistration(certificatePem),
  }
  const headers: ShcRegistrationHeaders = {
    Systempassword: Buffer.from(systemPassword, 'utf8').toString('base64'),
  }
  let response: ShcRegistrationPostResult
  try {
    response = await post(url, body, headers)
  } catch (err) {
    if (err instanceof Error && err.message === SHC_REGISTRATION_USER_ERROR) throw err
    throw new Error(SHC_REGISTRATION_USER_ERROR)
  }
  if (response.statusCode === 401) {
    throw new Error(SHC_PASSWORD_USER_ERROR)
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(SHC_REGISTRATION_USER_ERROR)
  }
  const token = parseRegistrationToken(response.bodyText)
  if (token === null) {
    throw new Error(SHC_REGISTRATION_USER_ERROR)
  }
  return { sslCertificate: certificatePem, sslKey: privateKeyPem, token }
}
