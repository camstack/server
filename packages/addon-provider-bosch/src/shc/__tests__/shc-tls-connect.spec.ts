import { describe, expect, it } from 'vitest'
import { shcTlsConnectOptions } from '../shc-client.js'

describe('shcTlsConnectOptions', () => {
  it('does not verify the controller certificate (self-signed chain)', () => {
    const opts = shcTlsConnectOptions({
      host: '192.168.1.59',
      sslCertificate: 'CERT',
      sslKey: 'KEY',
    })
    expect(opts.rejectUnauthorized).toBe(false)
    expect(opts.cert).toBe('CERT')
    expect(opts.key).toBe('KEY')
  })
})
