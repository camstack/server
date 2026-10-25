/**
 * The on-motion attach line names its CAMERA, not only its node.
 *
 * `detection session: dispatched on motion` carried `tags: { nodeId }` alone.
 * The question actually asked of it is per camera — "why did 102 attach late?",
 * "did 101 attach at all before the subject left?" — and on a node that owns a
 * dozen cameras the node tag cannot answer either. Same rule, and the same
 * reason, as the media lines in `addon-post-analysis`.
 *
 * A source-shape check: the miss is a textual property of the call site, and the
 * dispatch it sits inside needs a live cluster to reach.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

it('`detection session: dispatched on motion` tags the deviceId', () => {
  const source = readFileSync(path.join(SRC_ROOT, 'session-dispatch-controller.ts'), 'utf8')
  const at = source.indexOf("log.info('detection session: dispatched on motion'")
  expect(at).toBeGreaterThan(-1)
  const callSite = source.slice(at, at + 400)
  expect(callSite).toMatch(/tags:\s*\{[^}]*deviceId/)
})

describe('the node tag is kept alongside it', () => {
  it('still names the node it dispatched to', () => {
    const source = readFileSync(path.join(SRC_ROOT, 'session-dispatch-controller.ts'), 'utf8')
    const at = source.indexOf("log.info('detection session: dispatched on motion'")
    expect(source.slice(at, at + 400)).toMatch(/tags:\s*\{[^}]*nodeId/)
  })
})
