/**
 * Where the `klf-200-api` library's own diagnostics go.
 *
 * The library writes `console.error` / `console.warn` from its login and socket
 * handlers, which would land in the runner's raw output with no device or
 * integration tag. The build rewrites those calls (see `vite.config.ts`) to this
 * sink, so they reach the addon logger as debug lines, or nowhere when no sink is
 * set. The failure itself is still reported by the code that awaited the call.
 */
export type KlfLibraryLogSink = (level: 'warn' | 'error', message: string) => void

let sink: KlfLibraryLogSink | null = null

/** Route library diagnostics to `next`, or stop routing them with `null`. */
export function setKlfLibraryLogSink(next: KlfLibraryLogSink | null): void {
  sink = next
}

/** Drop-in for the `console` calls inside the library. */
export const klfLibraryLog = {
  error: (message: string): void => sink?.('error', message),
  warn: (message: string): void => sink?.('warn', message),
}
