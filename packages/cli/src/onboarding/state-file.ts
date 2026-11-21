/**
 * What the onboarding flow remembers on THIS machine between tool calls, before
 * a hub exists to hold anything: the last feasibility verdict. One small file,
 * `~/.camstack/onboarding.json`, mode 0600. It holds no secret and no address.
 *
 * A file that is missing, unreadable or of another shape reads as "nothing
 * remembered" — never as a verdict.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'

export const RememberedFeasibilitySchema = z.object({
  atMs: z.number(),
  verdict: z.enum(['hub-only', 'hub-plus-agents', 'not-a-hub']),
  cameras: z.number().int().positive(),
  hardwareClass: z.string(),
  /** Whether the hardware class has a column in the measured tables. */
  measured: z.boolean(),
  cpuModel: z.string().nullable(),
  accelerators: z.array(z.string()),
  reasons: z.array(z.string()),
})
export type RememberedFeasibility = z.infer<typeof RememberedFeasibilitySchema>

export const OnboardingStateSchema = z.object({
  feasibility: RememberedFeasibilitySchema.nullable(),
})
export type OnboardingState = z.infer<typeof OnboardingStateSchema>

export const EMPTY_ONBOARDING_STATE: OnboardingState = { feasibility: null }

export interface OnboardingStateStore {
  read(): OnboardingState
  /** `false`: the state could not be written; the caller says so, nothing throws. */
  write(state: OnboardingState): boolean
}

export const ONBOARDING_STATE_FILE = path.join(os.homedir(), '.camstack', 'onboarding.json')

export function fileStateStore(file: string = ONBOARDING_STATE_FILE): OnboardingStateStore {
  return {
    read() {
      try {
        const parsed = OnboardingStateSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
        return parsed.success ? parsed.data : EMPTY_ONBOARDING_STATE
      } catch {
        return EMPTY_ONBOARDING_STATE
      }
    },
    write(state) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
        fs.chmodSync(file, 0o600)
        return true
      } catch {
        return false
      }
    },
  }
}

export function memoryStateStore(
  initial: OnboardingState = EMPTY_ONBOARDING_STATE,
): OnboardingStateStore {
  let held = initial
  return {
    read: () => held,
    write(state) {
      held = state
      return true
    },
  }
}
