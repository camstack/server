import { parseArgs } from 'node:util'

interface ServeOptions {
  readonly port?: string
  readonly data?: string
}

export function buildServeEnv(opts: ServeOptions): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    // `CAMSTACK_ROLE`, not `CAMSTACK_MODE` — see agent.ts. This one worked
    // only because an empty role DEFAULTS to hub, i.e. by accident.
    CAMSTACK_ROLE: 'hub',
  }
  if (opts.port) env.PORT = opts.port
  if (opts.data) env.CAMSTACK_DATA = opts.data
  return env
}

export async function runServe(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      port: { type: 'string', short: 'p' },
      data: { type: 'string', short: 'd' },
    },
    strict: true,
    allowPositionals: false,
  })
  const opts: ServeOptions = {
    ...(typeof values.port === 'string' ? { port: values.port } : {}),
    ...(typeof values.data === 'string' ? { data: values.data } : {}),
  }
  Object.assign(process.env, buildServeEnv(opts))
  // Optional runtime dep — see package.json `optionalDependencies`.
  // `npx @camstack/cli serve` only makes sense inside a repo checkout or
  // when @camstack/server is co-installed.
  // The launcher reads the role and wires the framework paths; `main.js` is
  // the hub bootstrap and skips both.
  await import('@camstack/server/launcher.js')
}
