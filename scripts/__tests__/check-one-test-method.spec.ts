import { describe, expect, it } from 'vitest'
import { findViolations, testMethodsOf } from '../check-one-test-method.js'

const cap = (name: string, body: string) => ({
  path: `packages/types/src/capabilities/${name}`,
  text: body,
})
const INSTANCES = `
    testInstance: optionalMethod(
      z.object({ id: z.string() }),
`
const SECOND = `
    testConnection: method(
      z.object({ host: z.string() }),
`
const LOGIN = `
    validateCredentials: method(
      z.object({ user: z.string() }),
`

describe('check-one-test-method', () => {
  it('reads test and validate…Credentials methods, nothing else', () => {
    expect(
      testMethodsOf(
        INSTANCES + SECOND + LOGIN + '    getFoo: method(\n    runAudioTest: method(\n',
      ),
    ).toEqual(['testInstance', 'testConnection', 'validateCredentials'])
  })

  it('reads verify, check, probe and ping methods too (a second test under another name)', () => {
    expect(
      testMethodsOf(
        '    verify: method(\n    checkBackupKey: method(\n    probeStream: optionalMethod(\n    pingRelay: method(\n    getStatus: method(\n',
      ),
    ).toEqual(['verify', 'checkBackupKey', 'probeStream', 'pingRelay'])
  })

  it('refuses an unlisted verify like the smtp-provider one', () => {
    const found = findViolations(
      [cap('smtp-provider.cap.ts', '    verify: method(\n      RelaySchema,\n')],
      {},
      {},
    )
    expect(found).toHaveLength(1)
  })

  it('accepts testInstance, a permanent and a pending entry', () => {
    const found = findViolations(
      [
        cap('integration-instances.cap.ts', INSTANCES),
        cap('user-management.cap.ts', LOGIN),
        cap('legacy-probe.cap.ts', SECOND),
      ],
      { 'user-management.cap.ts:validateCredentials': 'login' },
      { 'legacy-probe.cap.ts:testConnection': 'a pending fixture entry' },
    )
    expect(found).toEqual([])
  })

  it('refuses a new connection test on a fixture', () => {
    const found = findViolations([cap('acme.cap.ts', SECOND)], {}, {})
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toContain('testInstance')
  })

  it('refuses a stale allow-list entry', () => {
    const found = findViolations([], { 'gone.cap.ts:testX': 'x' }, {})
    expect(found[0]?.message).toContain('remove the line')
  })
})
