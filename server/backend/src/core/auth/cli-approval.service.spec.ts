import { describe, it, expect } from 'vitest'
import {
  CliApprovalService,
  CLI_APPROVAL_MAX_PENDING,
  CLI_APPROVAL_MAX_PENDING_PER_IP,
  CLI_APPROVAL_TTL_MS,
  normalizeUserCode,
} from './cli-approval.service.js'

function clock(start = 1_000_000) {
  const s = { now: start }
  return { now: () => s.now, advance: (ms: number) => void (s.now += ms) }
}

describe('CliApprovalService', () => {
  it('begins with an 8-char Crockford code and a cda_ secret', () => {
    const svc = new CliApprovalService()
    const r = svc.begin({ ip: '192.0.2.1', client: 'camstack-cli' })
    expect(r.userCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(r.deviceSecret).toMatch(/^cda_[0-9a-f]{64}$/)
    expect(r.intervalSec).toBe(3)
  })

  it('keeps hashes only: neither the secret nor the code appears in the stored state', () => {
    const svc = new CliApprovalService()
    const r = svc.begin({ ip: '192.0.2.1' })
    const dump = JSON.stringify([
      ...Reflect.get(svc, 'bySecret').entries(),
      ...Reflect.get(svc, 'byCode').entries(),
    ])
    expect(dump).not.toContain(r.deviceSecret)
    expect(dump).not.toContain(r.userCode.replace('-', ''))
  })

  it('approve then poll hands over the user once, then the secret is dead', () => {
    const svc = new CliApprovalService()
    const r = svc.begin()
    expect(svc.poll(r.deviceSecret).status).toBe('pending')
    expect(svc.approve(r.userCode.toLowerCase(), 'u-1')).toBe('ok')
    expect(svc.poll(r.deviceSecret)).toEqual({
      status: 'approved',
      userId: 'u-1',
      requestId: expect.any(String),
      requester: {},
    })
    expect(svc.poll(r.deviceSecret).status).toBe('unknown')
    expect(svc.approve(r.userCode, 'u-2')).toBe('unknown')
  })

  it('a decision is final and deny reports denied once', () => {
    const svc = new CliApprovalService()
    const r = svc.begin()
    expect(svc.deny({ userCode: r.userCode })).toBe('ok')
    expect(svc.approve(r.userCode, 'u-1')).toBe('already-decided')
    expect(svc.poll(r.deviceSecret).status).toBe('denied')
    expect(svc.poll(r.deviceSecret).status).toBe('unknown')
  })

  it('expires after five minutes', () => {
    const c = clock()
    const svc = new CliApprovalService(c.now)
    const r = svc.begin()
    c.advance(CLI_APPROVAL_TTL_MS + 1)
    expect(svc.describe(r.userCode)).toBeNull()
    expect(svc.approve(r.userCode, 'u-1')).toBe('unknown')
    expect(svc.poll(r.deviceSecret).status).toBe('expired')
  })

  it('answers slow_down when polled faster than the interval', () => {
    const c = clock()
    const svc = new CliApprovalService(c.now)
    const r = svc.begin()
    expect(svc.poll(r.deviceSecret).status).toBe('pending')
    c.advance(1000)
    const slow = svc.poll(r.deviceSecret)
    expect(slow).toEqual({ status: 'slow_down', intervalSec: 5 })
    c.advance(5000)
    expect(svc.poll(r.deviceSecret).status).toBe('pending')
  })

  it('bounds pending requests per ip', () => {
    const svc = new CliApprovalService()
    for (let i = 0; i < CLI_APPROVAL_MAX_PENDING_PER_IP; i += 1) svc.begin({ ip: '192.0.2.9' })
    expect(() => svc.begin({ ip: '192.0.2.9' })).toThrow()
  })

  it('requests with no address share one capped bucket', () => {
    const svc = new CliApprovalService()
    for (let i = 0; i < CLI_APPROVAL_MAX_PENDING_PER_IP; i += 1) svc.begin()
    expect(() => svc.begin()).toThrow()
  })

  it('a full table evicts instead of refusing, and stays bounded', () => {
    const svc = new CliApprovalService()
    const victim = svc.begin({ ip: '198.51.100.1' })
    for (let i = 0; i < CLI_APPROVAL_MAX_PENDING - 1; i += 1)
      svc.begin({ ip: `198.51.${i % 250}.${i}` })
    expect(svc.pendingCount).toBe(CLI_APPROVAL_MAX_PENDING)
    const fresh = svc.begin({ ip: '203.0.113.1' })
    expect(svc.pendingCount).toBe(CLI_APPROVAL_MAX_PENDING)
    expect(svc.poll(fresh.deviceSecret).status).toBe('pending')
    expect(svc.poll(victim.deviceSecret).status).toBe('unknown')
  })

  it('keeps the observed User-Agent apart from the self-reported client', () => {
    const svc = new CliApprovalService()
    const r = svc.begin({ ip: '192.0.2.1', client: 'self', userAgent: 'seen-ua' })
    expect(svc.describe(r.userCode)).toMatchObject({ client: 'self', userAgent: 'seen-ua' })
  })

  it('lists pending requests without any code and denies by request id', () => {
    const svc = new CliApprovalService()
    const r = svc.begin({ ip: '192.0.2.1', client: 'x' })
    const [view] = svc.listPending()
    expect(JSON.stringify(view)).not.toContain(r.userCode.replace('-', ''))
    expect(svc.deny({ requestId: view!.requestId })).toBe('ok')
    expect(svc.listPending()).toHaveLength(0)
  })

  it('normalizes look-alike characters', () => {
    expect(normalizeUserCode('abil-o0u')).toBe('AB110 0U'.replace(/ /g, ''))
  })
})
