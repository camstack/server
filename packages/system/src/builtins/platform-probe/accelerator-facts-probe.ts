/**
 * Read the accelerator compute the inference worker published (D930), or ask
 * the same script once when this process has the embedded interpreter.
 *
 * A missing file and a failed probe are `null` — not an empty list, and not
 * zeros. `getHardware` overlays a published file onto the cached probe so a
 * pool that starts later still reaches Auto tune.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { parseAcceleratorFactsJson, type AcceleratorCompute } from '@camstack/types'

/** Same name `accelerator_facts.FACTS_FILENAME` writes under the system temp dir. */
export const ACCELERATOR_FACTS_FILENAME = 'camstack-accelerator-facts.json'

/** OpenVINO import is a few seconds; past this the estimate waits for the pool's file. */
export const ACCELERATOR_FACTS_TIMEOUT_MS = 8_000

const execFileAsync = promisify(execFile)

export function publishedAcceleratorFactsPath(): string {
  return path.join(os.tmpdir(), ACCELERATOR_FACTS_FILENAME)
}

function jsonValue(text: string): unknown {
  // JSON.parse is typed any. The assignment is the boundary; callers narrow.
  const value: unknown = JSON.parse(text)
  return value
}

/** `null` when the file is absent, unreadable, or not a facts payload. */
export function readPublishedAcceleratorFacts(
  filePath: string,
): readonly AcceleratorCompute[] | null {
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  try {
    return parseAcceleratorFactsJson(jsonValue(text))
  } catch {
    return null
  }
}

/** Where `accelerator_facts.py` lives, or null when this process cannot see the addon. */
export function findAcceleratorFactsScript(
  dataDir: string | null | undefined,
  cwd: string = process.cwd(),
): string | null {
  const candidates: string[] = []
  if (typeof dataDir === 'string' && dataDir !== '') {
    candidates.push(
      path.join(dataDir, 'addons', '@camstack', 'addon-pipeline', 'python', 'accelerator_facts.py'),
    )
  }
  candidates.push(path.join(cwd, 'packages', 'addon-pipeline', 'python', 'accelerator_facts.py'))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

export interface AcceleratorFactsExec {
  (command: string, args: readonly string[], timeoutMs: number): Promise<string>
}

async function defaultExec(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  })
  return stdout
}

export interface AcceleratorFactsProbeInput {
  readonly pythonPath: string | null
  readonly scriptPath: string | null
  readonly exec?: AcceleratorFactsExec
  readonly timeoutMs?: number
}

/**
 * Run the facts script. `null` when there is no interpreter, no script, or
 * the script could not ask the device (it prints `{"accelerators": null}`).
 */
export async function runAcceleratorFactsProbe(
  input: AcceleratorFactsProbeInput,
): Promise<readonly AcceleratorCompute[] | null> {
  if (input.pythonPath === null || input.scriptPath === null) return null
  const exec = input.exec ?? defaultExec
  try {
    const stdout = await exec(
      input.pythonPath,
      [input.scriptPath],
      input.timeoutMs ?? ACCELERATOR_FACTS_TIMEOUT_MS,
    )
    return parseAcceleratorFactsJson(jsonValue(stdout))
  } catch {
    return null
  }
}
