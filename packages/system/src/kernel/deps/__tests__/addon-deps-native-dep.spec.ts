/**
 * A requirements file that declares the Coral delegate gets it staged by the
 * same call that pip-installs it — the half of the edgetpu runtime pip cannot
 * deliver. Before this, `ai-edge-litert` installed on a desktop agent and
 * every edgetpu pool then failed `load_delegate` at a `/data/deps/…` path the
 * desktop does not have.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ensureEdgetpuDelegate = vi.fn(async () => ({
  kind: 'ready' as const,
  path: '/x/libedgetpu.so.1',
  origin: 'downloaded' as const,
}))
const installPythonRequirements = vi.fn(async () => undefined)

vi.mock('@camstack/types/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/types/node')>()
  return {
    ...actual,
    ensurePython: vi.fn(async () => '/py/bin/python3'),
    installPythonRequirements,
    ensureEdgetpuDelegate,
  }
})

const { AddonDepsManager } = await import('../addon-deps-manager.js')

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
  withTags: () => logger,
}

describe('AddonDepsManager.installPythonRequirements — declared native deps', () => {
  let dir: string
  let prevData: string | undefined
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-native-'))
    prevData = process.env['CAMSTACK_DATA']
    process.env['CAMSTACK_DATA'] = dir
    ensureEdgetpuDelegate.mockClear()
    installPythonRequirements.mockClear()
  })
  afterEach(() => {
    if (prevData === undefined) delete process.env['CAMSTACK_DATA']
    else process.env['CAMSTACK_DATA'] = prevData
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('stages the Coral delegate under the node data root after pip', async () => {
    const req = path.join(dir, 'requirements-edgetpu.txt')
    fs.writeFileSync(req, 'ai-edge-litert==2.1.6\n# camstack-native-dep: edgetpu-delegate\n')
    await new AddonDepsManager(dir, logger).installPythonRequirements(req)
    expect(installPythonRequirements).toHaveBeenCalledOnce()
    expect(ensureEdgetpuDelegate).toHaveBeenCalledOnce()
    expect(ensureEdgetpuDelegate).toHaveBeenCalledWith(dir, logger)
  })

  it('stages nothing for a file that declares no native dep', async () => {
    const req = path.join(dir, 'requirements-openvino.txt')
    fs.writeFileSync(req, 'openvino==2025.3.0\n# libedgetpu is mentioned, not declared\n')
    await new AddonDepsManager(dir, logger).installPythonRequirements(req)
    expect(ensureEdgetpuDelegate).not.toHaveBeenCalled()
  })

  it('the shipped requirements-edgetpu.txt declares the delegate', () => {
    const shipped = path.resolve(
      __dirname,
      '../../../../../addon-pipeline/python/requirements-edgetpu.txt',
    )
    expect(fs.readFileSync(shipped, 'utf8')).toMatch(/^# camstack-native-dep: edgetpu-delegate$/m)
  })
})
