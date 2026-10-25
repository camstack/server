/**
 * Entry of the Windows service's supervisor: `node.exe service-supervisor.js
 * <starter.js>`. WinSW runs this; this runs the starter and relaunches it on
 * any exit (see `supervisor.ts` for why). Standalone CJS — it runs outside the
 * asar under the bundled real Node, with nothing but Node built-ins.
 */
import { spawn } from 'node:child_process'
import { NodeSupervisor } from './supervisor'

const starter = process.argv[2]
if (starter === undefined || starter.length === 0) {
  console.error('[service-supervisor] usage: service-supervisor.js <starter.js>')
  process.exit(2)
}

const supervisor = new NodeSupervisor({
  spawnChild: () => {
    const proc = spawn(process.execPath, [starter], { stdio: 'inherit', env: process.env })
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      proc.once('exit', (code, signal) => resolve({ code, signal }))
      proc.once('error', (err) => {
        console.error(`[service-supervisor] cannot start the node: ${err.message}`)
        resolve({ code: null, signal: null })
      })
    })
    return { exited, kill: () => void proc.kill() }
  },
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    }),
  now: () => Date.now(),
  log: (line) => console.log(`[service-supervisor] ${line}`),
})

// WinSW stops a console service with a CTRL+C / CTRL+BREAK; Node maps them to
// SIGINT / SIGBREAK on Windows. SIGTERM covers a manual `taskkill`.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
  process.on(sig, () => supervisor.stop())
}

void supervisor.run().then(() => process.exit(0))
