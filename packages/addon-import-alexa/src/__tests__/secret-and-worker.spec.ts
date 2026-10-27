import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { scrubSecrets, withSpeakSecretFiles } from '../speak/secret-file.js'
import { recordWorkerCrash, startAlexaWorker, type WorkerChild } from '../speak/worker-client.js'

const PASSWORD = 'refresh-token-secret-9f3a'

function loggerCapture(): { logger: IScopedLogger; warnings: string[] } {
  const warnings: string[] = []
  const logger: IScopedLogger = {
    debug() {},
    info() {},
    warn(_message, extras) {
      warnings.push(JSON.stringify(extras ?? {}))
    },
    error() {},
    child() {
      return logger
    },
    withTags() {
      return logger
    },
  }
  return { logger, warnings }
}

interface FakePipe {
  readonly child: WorkerChild
  readonly written: string[]
  reply(line: unknown): void
  stderr(text: string): void
  close(code: number | null): void
}

function fakePipe(): FakePipe {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const life = new EventEmitter()
  const written: string[] = []
  const child: WorkerChild = {
    stdin: {
      write(chunk: string): void {
        written.push(chunk)
      },
    },
    stdout: {
      on(_event, listener): void {
        stdout.on('data', listener)
      },
    },
    stderr: {
      on(_event, listener): void {
        stderr.on('data', listener)
      },
    },
    on(event, listener): void {
      life.on(event, listener)
    },
    kill(): void {
      life.emit('close', null)
    },
  }
  return {
    child,
    written,
    reply(line: unknown): void {
      stdout.emit('data', Buffer.from(`${JSON.stringify(line)}\n`))
    },
    stderr(text: string): void {
      stderr.emit('data', Buffer.from(text))
    },
    close(code: number | null): void {
      life.emit('close', code)
    },
  }
}

describe('speak secrets and the worker', () => {
  it('writes the refresh token 0600 and does not put it on argv, env, stdin, or a log line', async () => {
    const pipe = fakePipe()
    const captured: { argv: string[]; env: NodeJS.ProcessEnv } = { argv: [], env: {} }
    const logs = loggerCapture()
    const worker = startAlexaWorker({
      pythonPath: '/usr/bin/python3',
      scriptPath: '/opt/alexa_worker.py',
      env: { PATH: '/usr/bin' },
      logger: logs.logger,
      spawnChild: (pythonPath, scriptPath, env) => {
        captured.argv = [pythonPath, scriptPath]
        captured.env = env
        return pipe.child
      },
    })
    worker.noteSecrets([PASSWORD])
    await withSpeakSecretFiles({ refreshToken: PASSWORD, sessionB64: '' }, async (paths) => {
      const mode = (await fs.stat(paths.refreshTokenPath)).mode & 0o777
      expect(mode).toBe(0o600)
      expect(await fs.readFile(paths.refreshTokenPath, 'utf8')).toBe(PASSWORD)
      const pending = worker.request({
        op: 'login_broker',
        label: 'alexa_001',
        refreshTokenPath: paths.refreshTokenPath,
        deviceAppName: 'Registered',
        domain: 'amazon.it',
        sessionPath: paths.sessionPath,
        region: 'EU',
      })
      pipe.stderr(`traceback token=${PASSWORD}\n`)
      pipe.reply({ id: '1', ok: true, result: { status: 'ok' } })
      await pending
    })
    const argv = captured.argv.join(' ')
    const env = JSON.stringify(captured.env)
    const stdin = pipe.written.join('')
    expect(argv).not.toContain(PASSWORD)
    expect(env).not.toContain(PASSWORD)
    expect(stdin).not.toContain(PASSWORD)
    expect(stdin).toContain('refreshTokenPath')
    expect(logs.warnings.join('\n')).not.toContain(PASSWORD)
    expect(logs.warnings.join('\n')).toContain('‹redacted›')
    worker.stop()
  })

  it('restarts a crashed worker until the bound, then refuses', async () => {
    const pipes: FakePipe[] = []
    const worker = startAlexaWorker({
      pythonPath: '/py',
      scriptPath: '/worker.py',
      maxCrashes: 3,
      schedule: (fn) => {
        fn()
      },
      spawnChild: () => {
        const pipe = fakePipe()
        pipes.push(pipe)
        return pipe.child
      },
    })
    const first = worker.request({ op: 'session_status' })
    pipes[0]?.reply({ id: '1', ok: true, result: { loggedIn: true, ageSec: 1, lastSuccessAt: 1 } })
    await expect(first).resolves.toEqual({ loggedIn: true, ageSec: 1, lastSuccessAt: 1 })
    pipes[0]?.close(1)
    pipes[1]?.close(1)
    pipes[2]?.close(1)
    expect(worker.failed).toBe(true)
    expect(pipes.length).toBe(3)
    await expect(worker.request({ op: 'devices' })).rejects.toThrow(/restart bound/)
  })

  it('records crashes immutably', () => {
    const first = recordWorkerCrash([], 1_000, 60_000, 2)
    expect(first.action).toBe('respawn')
    const second = recordWorkerCrash(first.times, 2_000, 60_000, 2)
    expect(second.action).toBe('failed')
    expect(first.times).toEqual([1_000])
  })
})

describe('scrubSecrets', () => {
  it('replaces the secret and leaves an empty secret alone', () => {
    expect(scrubSecrets(`see ${PASSWORD} now`, [PASSWORD])).toBe('see ‹redacted› now')
    expect(scrubSecrets('unchanged', [''])).toBe('unchanged')
  })
})
