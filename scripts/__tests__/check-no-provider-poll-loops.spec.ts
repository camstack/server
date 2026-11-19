import { describe, expect, it } from 'vitest'
import { findProviderPollLoops, MIGRATED } from '../check-no-provider-poll-loops'

const file = (rel: string, content: string) => [{ rel, content }]
const REL = 'packages/addon-provider-vesync/src/vesync-integration-manager.ts'

describe('check-no-provider-poll-loops (D1062)', () => {
  it('lists VeSync as migrated', () => {
    expect(MIGRATED).toContain('packages/addon-provider-vesync')
  })

  it('flags a setInterval poll loop', () => {
    const findings = findProviderPollLoops(
      file(REL, `this.#pollTimer = setInterval(() => {\n  void this.poll()\n}, 30_000)\n`),
    )
    expect(findings).toEqual([
      { file: REL, line: 1, text: 'this.#pollTimer = setInterval(() => {' },
    ])
  })

  it('flags a self re-arming setTimeout and a pollLoop helper', () => {
    const findings = findProviderPollLoops(
      file(REL, `const tick = () => { setTimeout(tick, 5000) }\nthis.#startPollLoop()\n`),
    )
    expect(findings.map((f) => f.line)).toEqual([1, 2])
  })

  it('ignores prose in comments and code without timers', () => {
    expect(
      findProviderPollLoops(
        file(
          REL,
          `// the old setInterval poll loop is gone (D1062)\n/**\n * no pollTimer\n */\nawait manager.refresh(reason, targets)\n`,
        ),
      ),
    ).toEqual([])
  })

  it('exempts a timer that names why it is not a state poll, and only that', () => {
    const marked = `this.#hb = setInterval(ping, 5000) // not-a-state-poll: connection keepalive\n`
    expect(findProviderPollLoops(file(REL, marked))).toEqual([])
    const bare = `this.#hb = setInterval(ping, 5000) // not-a-state-poll:\n`
    expect(findProviderPollLoops(file(REL, bare))).toHaveLength(1)
  })
})
