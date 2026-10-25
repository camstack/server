import { describe, expect, it } from 'vitest'
import { appendProgressLog } from '../components/ImportProgressModal.js'

describe('appendProgressLog', () => {
  it('prefers raw log lines and caps the buffer', () => {
    let logs: readonly string[] = []
    logs = appendProgressLog(logs, { phase: 'convert', detail: 'openvino/fp16', pct: 0 })
    expect(logs[0]).toMatch(/\[convert\].*openvino/)
    logs = appendProgressLog(logs, { phase: 'log', log: 'stderr line' })
    expect(logs.at(-1)).toBe('stderr line')
    for (let i = 0; i < 10; i++) {
      logs = appendProgressLog(logs, { phase: 'log', log: `n${i}` }, 5)
    }
    expect(logs).toHaveLength(5)
    expect(logs[0]).toBe('n5')
  })
})
