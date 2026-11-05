import { createServer } from 'node:net'

/** A bind probe: can this port be taken on this host right now? */
export function probeBind(
  port: number,
  host: string,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', (err: Error) => resolve({ ok: false, error: err.message }))
    probe.listen(port, host, () => {
      probe.close(() => resolve({ ok: true, latencyMs: Date.now() - started }))
    })
  })
}
