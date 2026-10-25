/**
 * Gate for hub-side simpleEvent traces.
 *
 * Hub-child events arrive on the parent's Baichuan socket. Logging them on
 * the child logger only is invisible when the operator filters Logs to the
 * Hub; logging every channel unconditionally floods the Hub (battery ticks).
 * Trace when the target camera — or the hub itself — is under debug.
 */
export function shouldTraceSimpleEventDispatch(input: {
  readonly hubDebugGeneral: boolean
  readonly hubSocketFlags: readonly string[]
  readonly childDebugGeneral: boolean
  readonly childSocketFlags: readonly string[]
}): boolean {
  return (
    wantsEventTrace(input.hubDebugGeneral, input.hubSocketFlags) ||
    wantsEventTrace(input.childDebugGeneral, input.childSocketFlags)
  )
}

function wantsEventTrace(debugGeneral: boolean, socketFlags: readonly string[]): boolean {
  return debugGeneral || socketFlags.includes('traceEvents')
}

/** Narrow a persisted `debugSocketLogs` blob to string flags. */
export function asDebugSocketFlags(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}
