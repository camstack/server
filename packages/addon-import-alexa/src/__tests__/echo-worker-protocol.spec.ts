import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { startAlexaWorker, type WorkerChild } from '../speak/worker-client.js'
import {
  parseDndState,
  parsePlayerState,
  RateLimitedError,
  requestLine,
} from '../speak/worker-protocol.js'

function fakeChild(): {
  child: WorkerChild
  reply: (line: unknown) => void
  written: string[]
} {
  const stdout = new EventEmitter()
  const life = new EventEmitter()
  const written: string[] = []
  const child: WorkerChild = {
    stdin: { write: (chunk: string) => void written.push(chunk) },
    stdout: { on: (_e, listener) => void stdout.on('data', listener) },
    stderr: { on: () => undefined },
    on: (event, listener) => void life.on(event, listener),
    kill: () => void life.emit('close', null),
  }
  return {
    child,
    written,
    reply: (line) => void stdout.emit('data', Buffer.from(`${JSON.stringify(line)}\n`)),
  }
}

describe('Echo worker protocol', () => {
  it('encodes the new ops', () => {
    expect(JSON.parse(requestLine('1', { op: 'set_volume', serial: 's', level: 30 }))).toEqual({
      id: '1',
      op: 'set_volume',
      serial: 's',
      level: 30,
    })
  })

  it('parses a player state with every field missing or null', () => {
    expect(parsePlayerState({ playerInfo: {} })).toEqual({})
    expect(parsePlayerState({ playerInfo: null })).toEqual({})
    expect(
      parsePlayerState({
        playerInfo: { state: null, volume: { volume: null, muted: null } },
      }),
    ).toMatchObject({ state: null })
    expect(() => parsePlayerState({ playerInfo: 'x' })).toThrow()
  })

  it('parses the Do Not Disturb list by serial', () => {
    expect(parseDndState({ devices: [{ serial: 'a', enabled: true }] }).get('a')).toBe(true)
    expect(() => parseDndState({ devices: [{ serial: 'a' }] })).toThrow()
  })

  it('a worker line with the rate-limited code rejects as a RateLimitedError, never as empty', async () => {
    const pipe = fakeChild()
    const worker = startAlexaWorker({
      pythonPath: 'python3',
      scriptPath: 'w.py',
      env: {},
      spawnChild: () => pipe.child,
    })
    const pending = worker.request({
      op: 'player_state',
      serial: 's',
      deviceType: 'T',
    })
    pipe.reply({
      id: '1',
      ok: false,
      error: 'amazon rate limit (429)',
      code: 'rate-limited',
    })
    await expect(pending).rejects.toBeInstanceOf(RateLimitedError)
    const second = worker.request({ op: 'dnd_state' })
    pipe.reply({ id: '2', ok: false, error: 'boom' })
    await expect(second).rejects.not.toBeInstanceOf(RateLimitedError)
    worker.stop()
  })
})
