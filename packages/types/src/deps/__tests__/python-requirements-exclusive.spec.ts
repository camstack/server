import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[][] = []
let installed = new Set<string>()

vi.mock('node:child_process', () => ({
  execFileSync: (_bin: string, args: readonly string[]): Buffer => {
    calls.push([...args])
    if (args[2] === 'show') {
      const dist = args[args.length - 1]
      if (dist !== undefined && installed.has(dist)) return Buffer.from('')
      throw new Error('not found')
    }
    if (args[2] === 'uninstall') {
      for (const a of args.slice(3)) installed.delete(a)
    }
    return Buffer.from('')
  },
}))

import type { IScopedLogger } from '../../interfaces/logging.js'
import { installPythonRequirements } from '../python-downloader.js'

const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

describe('installPythonRequirements exclusiveOf', () => {
  let root: string
  let python: string
  let file: string

  beforeEach(() => {
    calls.length = 0
    installed = new Set()
    root = mkdtempSync(join(tmpdir(), 'pyreq-'))
    mkdirSync(join(root, 'bin'))
    python = join(root, 'bin', 'python3')
    file = join(root, 'requirements-onnxruntime-gpu.txt')
    writeFileSync(file, 'onnxruntime-gpu\n')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const verbs = (): string[] => calls.map((c) => c[2] ?? '')

  it('uninstalls the CPU wheel found in the venv, then force-reinstalls the file', async () => {
    installed.add('onnxruntime')
    await installPythonRequirements(python, file, logger, { exclusiveOf: ['onnxruntime'] })
    expect(verbs()).toEqual(['show', 'uninstall', 'install'])
    expect(calls[1]).toContain('onnxruntime')
    expect(calls[2]).toContain('--force-reinstall')
    expect(installed.has('onnxruntime')).toBe(false)
  })

  it('reinstalls even when the file marker exists, if the conflicting wheel came back', async () => {
    await installPythonRequirements(python, file, logger, { exclusiveOf: ['onnxruntime'] })
    calls.length = 0
    installed.add('onnxruntime')
    await installPythonRequirements(python, file, logger, { exclusiveOf: ['onnxruntime'] })
    expect(verbs()).toEqual(['show', 'uninstall', 'install'])
  })

  it('does nothing beyond the probe when no conflict is installed and the marker exists', async () => {
    await installPythonRequirements(python, file, logger, { exclusiveOf: ['onnxruntime'] })
    calls.length = 0
    await installPythonRequirements(python, file, logger, { exclusiveOf: ['onnxruntime'] })
    expect(verbs()).toEqual(['show'])
  })

  it('a first install without a conflict is a plain install', async () => {
    await installPythonRequirements(python, file, logger, { exclusiveOf: ['onnxruntime'] })
    expect(verbs()).toEqual(['show', 'install'])
    expect(calls[1]).not.toContain('--force-reinstall')
  })
})
