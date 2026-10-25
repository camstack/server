import { getCACertificates } from 'node:tls'
import { describe, expect, it } from 'vitest'
import { applyWyzeCloudTlsTrust, DIGICERT_GLOBAL_ROOT_CA_PEM } from '../wyze-tls-trust.js'

describe('applyWyzeCloudTlsTrust', () => {
  it('installs DigiCert Global Root CA into the process trust store', () => {
    applyWyzeCloudTlsTrust()
    const certs = getCACertificates()
    const marker = DIGICERT_GLOBAL_ROOT_CA_PEM.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')
    expect(certs.some((c) => c.replace(/\s/g, '').includes(marker.slice(0, 40)))).toBe(true)
  })
})
