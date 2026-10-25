/**
 * Decode-worker — the process ENTRY (its own vite build entry, the path
 * `fork-decode-worker.ts` forks). The worker itself is `DecodeWorkerChild` in
 * `decode-worker-child.ts`; its process wiring — IPC messages and the ONE exit
 * every ending goes through (D652, D666) — is `decode-worker-process.ts`, so a
 * test fixture runs the same wiring. This file adds only what needs native
 * modules or the sharp loader.
 *
 * ‼ SANCTIONED RAW IPC ‼ — `process.on('message')` / `process.send` are the
 * correct mechanism for this private, directly-forked worker only; see the
 * note at the top of `decode-worker-child.ts`.
 */

import { setSharpWarnSink } from '../shared/lazy-sharp.js'
import { wireDecodeWorkerProcess } from './decode-worker-process.js'

const { worker } = wireDecodeWorkerProcess(process)

// The lazy-sharp loader's ONE "sharp is unavailable" line would otherwise go to
// raw stderr, which the parent inherits but does not forward to the scoped
// logger — the same gap that hid every worker-side native-crop failure. Route it
// through `emitStderr` so it lands in `addons.getLogs` with its `[dev:<id>]`
// prefix, per-camera, at `warn`.
setSharpWarnSink((message: string): void => {
  worker.emitStderr(`decode-worker-child: ${message}\n`, 'warn')
})

// Preload the native modules as soon as the channel is up. Ordered AFTER the
// message listener (wired above) so a `start` that arrives mid-preload is
// handled (and shares the in-flight import) rather than dropped.
void worker.warm()
