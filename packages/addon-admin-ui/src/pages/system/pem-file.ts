/**
 * Client-side checks for the certificate upload on Network → Local access.
 * The hub validates the pair for real (`validateUploadedTls`: parses, key
 * matches, `serverAuth`); this only catches the wrong FILE before a round
 * trip — a key dropped on the certificate field, a DER file, a CSR.
 */

import i18n from '../../i18n/index'

export type PemKind = 'certificate' | 'privateKey' | 'ca'

const CERTIFICATE_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/
const PRIVATE_KEY_BLOCK =
  /-----BEGIN ((?:RSA |EC |ENCRYPTED )?PRIVATE KEY)-----[\s\S]+?-----END \1-----/

/** File-picker filters, per field. */
export const PEM_ACCEPT: Readonly<Record<PemKind, string>> = {
  certificate: '.pem,.crt,.cer',
  privateKey: '.pem,.key',
  ca: '.pem,.crt,.cer',
}

/**
 * `null` when `text` looks like the PEM the field wants (or is empty — an
 * empty field is "not filled in", not an error), otherwise the message to
 * show under the field.
 */
export function checkPem(kind: PemKind, text: string): string | null {
  if (text.trim() === '') return null
  if (kind === 'privateKey') {
    const match = PRIVATE_KEY_BLOCK.exec(text)
    if (match === null) {
      return CERTIFICATE_BLOCK.test(text)
        ? i18n.t('helpers.pemFile.isCert')
        : i18n.t('helpers.pemFile.notKey')
    }
    if (match[1] === 'ENCRYPTED PRIVATE KEY') {
      return i18n.t('helpers.pemFile.encrypted')
    }
    return null
  }
  if (!CERTIFICATE_BLOCK.test(text)) {
    return PRIVATE_KEY_BLOCK.test(text)
      ? i18n.t('helpers.pemFile.isKey')
      : i18n.t('helpers.pemFile.notCert')
  }
  if (kind === 'certificate' && PRIVATE_KEY_BLOCK.test(text)) {
    return i18n.t('helpers.pemFile.certHasKey')
  }
  return null
}

/** The text of a chosen file — read in the browser, never uploaded as a file. */
export function readPemFile(file: Blob): Promise<string> {
  return file.text()
}
