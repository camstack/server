import { describe, it, expect } from 'vitest'
import { buildHubHttpSource } from '../addon-upload.js'

describe('buildHubHttpSource', () => {
  it('stages the buffer and builds a hub-http descriptor', () => {
    const buf = Buffer.from('TGZ')
    const src = buildHubHttpSource(buf, 'https://192.168.1.20:4443')
    expect(src.kind).toBe('hub-http')
    expect(src.url).toMatch(/^https:\/\/192\.168\.1\.20:4443\/api\/addons\/deploy-bundle\//)
    expect(src.bytes).toBe(buf.length)
    expect(src.token).toBeTruthy()
    expect(src.sha256).toBeTruthy()
  })
})
