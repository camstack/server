import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findAcceleratorFactsScript,
  readPublishedAcceleratorFacts,
  runAcceleratorFactsProbe,
} from '../accelerator-facts-probe.js'

const written: string[] = []

afterEach(() => {
  for (const file of written.splice(0)) fs.rmSync(file, { recursive: true, force: true })
})

describe('accelerator facts probe', () => {
  it('reads a published file and treats a failed payload as null', () => {
    const file = path.join(os.tmpdir(), `accel-facts-${process.pid}.json`)
    written.push(file)
    fs.writeFileSync(
      file,
      JSON.stringify({
        accelerators: [
          {
            deviceKey: 'openvino:gpu',
            fullDeviceName: 'Intel',
            executionUnits: 24,
            clockMHz: 0,
            gops: null,
            architecture: null,
            npuName: null,
            tops: null,
            vendor: null,
            webgpuArchitecture: null,
            webgpuDevice: null,
            computeUnits: null,
          },
        ],
      }),
    )
    const rows = readPublishedAcceleratorFacts(file)
    expect(rows?.[0]?.executionUnits).toBe(24)
    expect(rows?.[0]?.clockMHz).toBeNull()
    expect(readPublishedAcceleratorFacts(path.join(os.tmpdir(), 'no-such-accel-facts.json'))).toBe(
      null,
    )
  })

  it('a script that reports null accelerators is a failed probe', async () => {
    const result = await runAcceleratorFactsProbe({
      pythonPath: 'python3',
      scriptPath: 'accelerator_facts.py',
      exec: async () => '{"accelerators": null}\n',
    })
    expect(result).toBeNull()
  })

  it('parses the script stdout and does not spawn when the script is missing', async () => {
    let calls = 0
    const result = await runAcceleratorFactsProbe({
      pythonPath: 'python3',
      scriptPath: 'accelerator_facts.py',
      exec: async () => {
        calls += 1
        return JSON.stringify({
          accelerators: [
            {
              deviceKey: 'openvino:npu',
              fullDeviceName: null,
              executionUnits: null,
              clockMHz: null,
              gops: { int8: 50, fp16: null },
              architecture: null,
              npuName: 'AI Boost',
              tops: null,
              vendor: null,
              webgpuArchitecture: null,
              webgpuDevice: null,
              computeUnits: null,
            },
          ],
        })
      },
    })
    expect(calls).toBe(1)
    expect(result?.[0]?.npuName).toBe('AI Boost')
    expect(result?.[0]?.gops).toEqual({ int8: 50, fp16: null })
    const skipped = await runAcceleratorFactsProbe({
      pythonPath: null,
      scriptPath: 'accelerator_facts.py',
      exec: async () => {
        calls += 1
        return '{}'
      },
    })
    expect(skipped).toBeNull()
    expect(calls).toBe(1)
  })

  it('prefers the addon copy under dataDir and falls back to the workspace tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accel-script-'))
    written.push(root)
    const addon = path.join(
      root,
      'addons',
      '@camstack',
      'addon-pipeline',
      'python',
      'accelerator_facts.py',
    )
    fs.mkdirSync(path.dirname(addon), { recursive: true })
    fs.writeFileSync(addon, '# addon\n')
    const workspace = path.join(
      root,
      'packages',
      'addon-pipeline',
      'python',
      'accelerator_facts.py',
    )
    fs.mkdirSync(path.dirname(workspace), { recursive: true })
    fs.writeFileSync(workspace, '# workspace\n')
    expect(findAcceleratorFactsScript(root, root)).toBe(addon)
    expect(findAcceleratorFactsScript(null, root)).toBe(workspace)
    expect(findAcceleratorFactsScript(undefined, root)).toBe(workspace)
    expect(findAcceleratorFactsScript(path.join(root, 'missing'), path.join(root, 'empty'))).toBe(
      null,
    )
  })
})
