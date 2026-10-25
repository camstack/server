import type { X509Certificate } from 'node:crypto'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { userError } from '@camstack/types'
import { writeOwnerOnlyFileSync } from '@camstack/types/node'
import { type CertOptions, ensureTlsCert, loadTlsCert, reissueTlsLeaf } from './cert-manager.js'
import { type HttpsReloadOutcome, reloadHttpsListener } from './https-listener.js'
import {
  readTlsMode,
  STORED_UPLOAD_CERT_FILE,
  STORED_UPLOAD_KEY_FILE,
  UPLOADED_CA_FILE,
  writeTlsMode,
} from './tls-status.js'
import { checkUploadedCa, validateUploadedTls } from './uploaded-cert.js'

/**
 * The certificate actions of Network → Local access (D726). Each one changes
 * the files under `<dataDir>/tls` and then puts them on the listener, so the
 * certificate the status reports is the certificate a client is served.
 */

export interface UploadCertificateInput {
  readonly certPem: string
  readonly keyPem: string
  readonly caPem?: string | undefined
}

function withNewline(pem: string): string {
  return pem.endsWith('\n') ? pem : `${pem}\n`
}

/** Test seam: the trust anchors that count as "public". Defaults to the ones Node ships. */
export interface UploadCertificateOptions {
  readonly publicRoots?: readonly X509Certificate[]
  readonly now?: Date
}

/**
 * Store an operator's certificate (D873). The material is validated first, and a
 * certificate that does not lead to a public CA must come with the CA that signed it
 * (validated: it is a CA, in date, and issued the leaf) - otherwise "Download CA" would
 * have nothing to hand out. Nothing is written when anything is refused.
 *
 * The leaf (or chain) and key are written twice: as the served pair, and as a kept copy
 * (`uploaded.crt` / `uploaded.key`, with the issuing CA in `uploaded-ca.crt`) that
 * "Revert to generated" leaves in place so the upload can be selected again. The local
 * CA (`camstack-ca.crt` + key) is never touched - it did not sign the upload, and it is
 * what every device that trusts it still needs.
 */
export async function storeUploadedCertificate(
  dataDir: string,
  input: UploadCertificateInput,
  options?: UploadCertificateOptions,
): Promise<void> {
  const valid = validateUploadedTls(input.certPem, input.keyPem)
  if (!valid.ok) throw userError(valid.code, {}, valid.error)
  const ca = checkUploadedCa(input.certPem, input.caPem, options)
  if (!ca.ok) throw userError(ca.code, {}, ca.error)
  const dir = join(dataDir, 'tls')
  await mkdir(dir, { recursive: true })
  const certText = withNewline(input.certPem)
  const keyText = withNewline(input.keyPem)
  writeOwnerOnlyFileSync(join(dir, STORED_UPLOAD_KEY_FILE), keyText)
  await writeFile(join(dir, STORED_UPLOAD_CERT_FILE), certText)
  const caPath = join(dir, UPLOADED_CA_FILE)
  if (ca.issuerPem !== null) {
    await writeFile(caPath, ca.issuerPem)
  } else {
    rmSync(caPath, { force: true })
  }
  await writeFile(join(dir, 'camstack.crt'), certText)
  writeOwnerOnlyFileSync(join(dir, 'camstack.key'), keyText)
  writeTlsMode(dataDir, 'uploaded')
}

/**
 * Serve the kept upload again after a revert (D873). Refused with a clear error when none
 * is kept; the generated material stays on disk and is untouched.
 */
export async function useStoredUploadedCertificate(dataDir: string): Promise<void> {
  const dir = join(dataDir, 'tls')
  const certPath = join(dir, STORED_UPLOAD_CERT_FILE)
  const keyPath = join(dir, STORED_UPLOAD_KEY_FILE)
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    throw userError('tls.no-stored-upload', {}, 'No uploaded certificate is kept on this node.')
  }
  copyFileSync(certPath, join(dir, 'camstack.crt'))
  copyFileSync(keyPath, join(dir, 'camstack.key'))
  writeTlsMode(dataDir, 'uploaded')
}

/** Issue a new generated leaf under the local CA. Refused while an upload is served. */
export async function regenerateCertificate(dataDir: string, options: CertOptions): Promise<void> {
  if (readTlsMode(dataDir) === 'uploaded') {
    throw new Error('Cannot regenerate an uploaded certificate — revert to generated first.')
  }
  await reissueTlsLeaf(dataDir, options)
}

/**
 * Serve the generated local-CA leaf again (D227). The uploaded certificate and its CA stay
 * on disk (D873) so it can be selected again; an upload made before they were kept is
 * copied aside first, from the pair being served.
 */
export async function revertToGeneratedCertificate(
  dataDir: string,
  options: CertOptions,
): Promise<void> {
  const dir = join(dataDir, 'tls')
  const keptCert = join(dir, STORED_UPLOAD_CERT_FILE)
  const keptKey = join(dir, STORED_UPLOAD_KEY_FILE)
  if (
    readTlsMode(dataDir) === 'uploaded' &&
    !existsSync(keptCert) &&
    existsSync(join(dir, 'camstack.crt')) &&
    existsSync(join(dir, 'camstack.key'))
  ) {
    copyFileSync(join(dir, 'camstack.crt'), keptCert)
    copyFileSync(join(dir, 'camstack.key'), keptKey)
  }
  writeTlsMode(dataDir, 'generated')
  await ensureTlsCert(dataDir, options)
}

/**
 * Put the pair on disk on the HTTPS listener. Called after every action, so
 * "the certificate changed" and "clients see it" are the same moment.
 */
export function applyCertificateToListener(dataDir: string): HttpsReloadOutcome {
  const certPath = join(dataDir, 'tls', 'camstack.crt')
  const keyPath = join(dataDir, 'tls', 'camstack.key')
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    return { kind: 'failed', error: `No certificate pair under ${join(dataDir, 'tls')}` }
  }
  return reloadHttpsListener(loadTlsCert(certPath, keyPath))
}
