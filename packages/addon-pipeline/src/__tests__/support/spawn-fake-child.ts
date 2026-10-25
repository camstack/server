import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { SpawnOptions } from 'node:child_process'
import type { FfmpegSpawnFn } from '../../stream-broker/stream-broker/ffmpeg-invocation.js'
import type { SpawnedFfmpegProcess } from '@camstack/types/node'

/** Minimal ffmpeg child for transcode / egress specs (stdout chunk + kill). */
export class FakeFfmpegChild extends EventEmitter implements SpawnedFfmpegProcess {
  killed = false
  readonly pid = 42_424
  readonly stdout: PassThrough = new PassThrough()
  readonly stderr: PassThrough = new PassThrough()

  constructor(emitStdoutOnTick = true) {
    super()
    if (emitStdoutOnTick) {
      setTimeout(() => {
        if (!this.killed) this.stdout.emit('data', Buffer.from([0, 1, 2]))
      }, 0)
    }
  }

  kill(): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
}

export interface SpawnTrace {
  readonly spawnArgs: string[][]
  readonly spawnCommands?: string[]
}

export function makeSpawnFn(
  trace: SpawnTrace,
  makeChild: () => FakeFfmpegChild = () => new FakeFfmpegChild(),
): FfmpegSpawnFn {
  return (command, args, _options?: SpawnOptions) => {
    trace.spawnArgs.push([...args])
    trace.spawnCommands?.push(command)
    return makeChild()
  }
}
