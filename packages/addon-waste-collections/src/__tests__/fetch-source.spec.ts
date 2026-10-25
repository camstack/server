import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchWasteSource } from '../fetch-source.js'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'node:child_process'

const spawnMock = vi.mocked(spawn)

function mockChild(opts: {
  stdout: string
  stderr?: string
  code: number | null
  writeError?: Error
}): void {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: (s: string) => void; end: () => void }
    kill: (sig?: string) => void
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = {
    write: () => undefined,
    end: () => {
      queueMicrotask(() => {
        if (opts.writeError) {
          child.emit('error', opts.writeError)
          return
        }
        child.stdout.emit('data', Buffer.from(opts.stdout))
        if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr))
        child.emit('close', opts.code)
      })
    },
  }
  child.kill = () => undefined
  spawnMock.mockReturnValue(child as never)
}

afterEach(() => {
  spawnMock.mockReset()
})

describe('fetchWasteSource', () => {
  it('returns entries on ok:true', async () => {
    mockChild({
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        entries: [{ date: '2026-10-12', type: 'Rest' }],
      }),
    })
    const entries = await fetchWasteSource(
      { pythonPath: '/py', scriptPath: '/fetch.py' },
      { source: 'ics', args: { url: 'https://example.com/x.ics' } },
    )
    expect(entries).toEqual([{ date: '2026-10-12', type: 'Rest' }])
    expect(spawnMock).toHaveBeenCalledWith('/py', ['/fetch.py'], expect.any(Object))
  })

  it('propagates ok:false as an error (never empty list)', async () => {
    mockChild({
      code: 1,
      stdout: JSON.stringify({ ok: false, error: 'bad street' }),
      stderr: 'Traceback…',
    })
    await expect(
      fetchWasteSource(
        { pythonPath: '/py', scriptPath: '/fetch.py' },
        { source: 'junker_app', args: {} },
      ),
    ).rejects.toThrow(/bad street/)
  })

  it('rejects non-JSON stdout', async () => {
    mockChild({ code: 0, stdout: 'not-json' })
    await expect(
      fetchWasteSource({ pythonPath: '/py', scriptPath: '/fetch.py' }, { source: 'ics', args: {} }),
    ).rejects.toThrow(/non-JSON/)
  })
})
