import { describe, it, expect } from 'vitest'
import { findReplayIsolationViolations, type ReplayFile } from '../check-replay-isolation.js'

const file = (path: string, source: string): ReplayFile => ({ path, source })

describe('findReplayIsolationViolations', () => {
  it('rejects an import of a production store', () => {
    const v = findReplayIsolationViolations([
      file('replay/replay-run.ts', `import { TrackStore } from '../store/track-store.js'`),
    ])
    expect(v).toHaveLength(1)
    expect(v[0]?.symbol).toBe('TrackStore')
  })

  it('rejects a call to the Notification Center', () => {
    // A replay that triggers a notification is not a dry-run: it is a delivery
    // with a fake input. It holds for the bus as much as for the store.
    const v = findReplayIsolationViolations([
      file('replay/replay-run.ts', `await this.api.notificationRules.testRule.mutate({})`),
    ])
    expect(v).toHaveLength(1)
  })

  it('lascia passare il proprio store', () => {
    const v = findReplayIsolationViolations([
      file('replay/replay-run.ts', `import { ReplayStore } from './replay-store.js'`),
    ])
    expect(v).toEqual([])
  })

  it('lets FrameProcessor through — it is the engine, not a writer', () => {
    const v = findReplayIsolationViolations([
      file(
        'replay/replay-run.ts',
        `import { FrameProcessor } from '../pipeline/frame-processor.js'`,
      ),
    ])
    expect(v).toEqual([])
  })

  it('also guards session-replay/ (D646) — a name ending in replay is a replay', () => {
    const v = findReplayIsolationViolations([
      file(
        'packages/addon-benchmark/src/session-replay/run-session-replay.ts',
        `import { TrackStore } from '../store/track-store.js'`,
      ),
    ])
    expect(v).toHaveLength(1)
  })

  it('does not look at files outside replay/', () => {
    const v = findReplayIsolationViolations([
      file('index.ts', `import { TrackStore } from './store/track-store.js'`),
    ])
    expect(v).toEqual([])
  })

  it('does not look inside a comment', () => {
    const v = findReplayIsolationViolations([
      file(
        'replay/replay-run.ts',
        `// questo modulo non chiama MAI TrackStore.upsert, solo FrameProcessor`,
      ),
    ])
    expect(v).toEqual([])
  })

  it('dedupe: two uses of the same forbidden symbol in the same file count once', () => {
    const v = findReplayIsolationViolations([
      file(
        'replay/replay-run.ts',
        `import { TrackStore } from '../store/track-store.js'\nTrackStore.upsert()`,
      ),
    ])
    expect(v).toHaveLength(1)
  })
})
