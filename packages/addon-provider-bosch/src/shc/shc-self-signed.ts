import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface SelfSignedRegistrationMaterial {
  readonly privateKeyPem: string
  readonly certificatePem: string
}

/**
 * RSA-2048 self-signed certificate. The controller stores this certificate;
 * it does not sign a CSR.
 */
export function generateSelfSignedRegistrationMaterial(
  clientId: string,
): SelfSignedRegistrationMaterial {
  const dir = mkdtempSync(join(tmpdir(), 'shc-cert-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-days',
        '3650',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-subj',
        `/CN=${clientId}/O=CamStack`,
        '-addext',
        'basicConstraints=critical,CA:TRUE',
      ],
      { stdio: 'pipe' },
    )
    return {
      privateKeyPem: readFileSync(keyPath, 'utf8'),
      certificatePem: readFileSync(certPath, 'utf8'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** One line of base64, with the carriage returns the controller requires around the PEM labels. */
export function formatCertificateForRegistration(pem: string): string {
  const flattened = pem.replace(/\r/g, '').replace(/\n/g, '')
  return flattened
    .replace('-----BEGIN CERTIFICATE-----', '-----BEGIN CERTIFICATE-----\r')
    .replace('-----END CERTIFICATE-----', '\r-----END CERTIFICATE-----')
}
