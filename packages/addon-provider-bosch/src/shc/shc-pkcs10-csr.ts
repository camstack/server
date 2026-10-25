import { createPrivateKey, createSign, generateKeyPairSync } from 'node:crypto'

export interface RsaRegistrationMaterial {
  readonly privateKeyPem: string
  readonly csrPem: string
}

/** RSA-2048 key pair and a PKCS#10 CSR (PEM) with subject CN = `clientId`. */
export function generateRsaRegistrationMaterial(clientId: string): RsaRegistrationMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const csrDer = buildPkcs10CertificationRequestDer(clientId, publicKey, privateKey)
  const csrPem = derToPem(csrDer, 'CERTIFICATE REQUEST')
  return { privateKeyPem: privateKey, csrPem }
}

function buildPkcs10CertificationRequestDer(
  commonName: string,
  subjectPublicKeyInfoDer: Buffer,
  privateKeyPem: string,
): Buffer {
  const version = encodeInteger(0)
  const subject = encodeSequence([encodeRelativeDistinguishedName(commonName)])
  const attributes = encodeContextSpecificConstructed(0, encodeSequence([]))
  const certificationRequestInfo = encodeSequence([
    version,
    subject,
    subjectPublicKeyInfoDer,
    attributes,
  ])
  const signature = createSign('RSA-SHA256')
  signature.update(certificationRequestInfo)
  signature.end()
  const signatureBits = signature.sign(privateKeyPem)
  const signatureAlgorithm = encodeSequence([encodeOid('1.2.840.113549.1.1.11'), encodeNull()])
  const signatureValue = encodeBitString(signatureBits)
  return encodeSequence([certificationRequestInfo, signatureAlgorithm, signatureValue])
}

function encodeRelativeDistinguishedName(commonName: string): Buffer {
  const cnAttr = encodeSequence([encodeOid('2.5.4.3'), encodeUtf8String(commonName)])
  return encodeSet([cnAttr])
}

function encodeOid(dotted: string): Buffer {
  const parts = dotted.split('.').map((p) => Number(p))
  const first = 40 * (parts[0] ?? 0) + (parts[1] ?? 0)
  const body: number[] = [first]
  for (const part of parts.slice(2)) {
    let n = part
    const stack: number[] = []
    do {
      stack.unshift(n & 0x7f)
      n >>= 7
    } while (n > 0)
    for (let i = 0; i < stack.length; i++) {
      const byte = stack[i] ?? 0
      body.push(i < stack.length - 1 ? byte | 0x80 : byte)
    }
  }
  return encodeTag(0x06, Buffer.from(body))
}

function encodeInteger(value: number): Buffer {
  return encodeTag(0x02, Buffer.from([value]))
}

function encodeNull(): Buffer {
  return encodeTag(0x05, Buffer.alloc(0))
}

function encodeUtf8String(value: string): Buffer {
  return encodeTag(0x0c, Buffer.from(value, 'utf8'))
}

function encodeBitString(bytes: Buffer): Buffer {
  return encodeTag(0x03, Buffer.concat([Buffer.from([0x00]), bytes]))
}

function encodeSequence(chunks: readonly Buffer[]): Buffer {
  return encodeTag(0x30, Buffer.concat(chunks))
}

function encodeSet(chunks: readonly Buffer[]): Buffer {
  return encodeTag(0x31, Buffer.concat(chunks))
}

function encodeContextSpecificConstructed(tag: number, content: Buffer): Buffer {
  return encodeTag(0xa0 | tag, content)
}

function encodeTag(tag: number, content: Buffer): Buffer {
  const len = encodeLength(content.length)
  return Buffer.concat([Buffer.from([tag]), len, content])
}

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  if (length <= 0xff) return Buffer.from([0x81, length])
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff])
}

function derToPem(der: Buffer, label: string): string {
  const b64 = der.toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/** Sanity check that a PEM private key parses (tests only). */
export function privateKeyParses(pem: string): boolean {
  try {
    createPrivateKey(pem)
    return true
  } catch {
    return false
  }
}
