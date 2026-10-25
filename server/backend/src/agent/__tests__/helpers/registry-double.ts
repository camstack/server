/**
 * Shared test double for `LocalChildRegistry` / `HubLocalChildDispatcher`.
 *
 * Imported by both `agent-cap-forwarding.spec.ts` and
 * `agent-cap-dispatch-wiring.spec.ts` so the spy shape is defined once.
 */
import { vi } from 'vitest'
import type { HubLocalChildDispatcher, CapCallInput } from '@camstack/system'

/**
 * A minimal test double for `LocalChildRegistry` that implements
 * `HubLocalChildDispatcher` using vi.fn() spies. The explicit generic
 * parameters ensure the spy fields are assignable to the interface methods
 * without any unsafe cast, while still exposing the full mock API
 * (`.mockReturnValue`, `.mock.calls`, etc.) for assertions.
 *
 * @param resolveResult  Value returned by `resolveChildId` — the resolved
 *                       childId string, or `null` when no child owns the cap.
 * @param callResult     Value the `callCapOnChild` spy resolves with.
 */
export interface RegistryDouble extends HubLocalChildDispatcher {
  resolveChildId: ReturnType<typeof vi.fn<(capName: string, deviceId?: number) => string | null>>
  callCapOnChild: ReturnType<
    typeof vi.fn<(childId: string, input: CapCallInput) => Promise<unknown>>
  >
}

export function makeRegistryDouble(
  resolveResult: string | null,
  callResult: unknown,
): RegistryDouble {
  return {
    resolveChildId: vi.fn<(capName: string, deviceId?: number) => string | null>(
      (_capName, _deviceId) => resolveResult,
    ),
    callCapOnChild: vi.fn<(childId: string, input: CapCallInput) => Promise<unknown>>(
      (_childId, _input) => Promise.resolve(callResult),
    ),
  }
}
