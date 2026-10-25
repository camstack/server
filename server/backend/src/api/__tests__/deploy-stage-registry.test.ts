import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { DeployStageRegistry } from '../deploy-stage-registry'

const buf = Buffer.from('fake-tgz-bytes')
const sha = createHash('sha256').update(buf).digest('hex')

describe('DeployStageRegistry', () => {
  it('stages and reports sha256 + bytes', () => {
    const r = new DeployStageRegistry()
    const s = r.stage(buf)
    expect(s.sha256).toBe(sha)
    expect(s.bytes).toBe(buf.length)
    expect(s.id).toBeTruthy()
    expect(s.token).toBeTruthy()
  })
  it('consume returns the buffer once with a valid token, then null (single-use)', () => {
    const r = new DeployStageRegistry()
    const s = r.stage(buf)
    expect(r.consume(s.id, s.token)?.equals(buf)).toBe(true)
    expect(r.consume(s.id, s.token)).toBeNull()
  })
  it('rejects a wrong token and unknown id', () => {
    const r = new DeployStageRegistry()
    const s = r.stage(buf)
    expect(r.consume(s.id, 'wrong')).toBeNull()
    expect(r.consume('nope', s.token)).toBeNull()
  })
  it('expires entries after ttl', () => {
    let t = 1000
    const r = new DeployStageRegistry({ ttlMs: 100, now: () => t })
    const s = r.stage(buf)
    t = 1201
    expect(r.consume(s.id, s.token)).toBeNull()
  })
  it('peekExists is true before consume, false after', () => {
    const r = new DeployStageRegistry()
    const s = r.stage(buf)
    expect(r.peekExists(s.id)).toBe(true)
    r.consume(s.id, s.token)
    expect(r.peekExists(s.id)).toBe(false)
  })
  it('peekExists returns false for an entry past its TTL', () => {
    let t = 1000
    const r = new DeployStageRegistry({ ttlMs: 100, now: () => t })
    const s = r.stage(buf)
    // Before expiry
    expect(r.peekExists(s.id)).toBe(true)
    // Advance time past TTL
    t = 1201
    expect(r.peekExists(s.id)).toBe(false)
  })
})
