/**
 * The Tailscale auth key joins a machine to the tailnet. On argv it is
 * visible to every process on the host, and execFile's `Command failed: …`
 * error message repeats the full command line, which the addon then threw
 * and logged. No environment variable either (operator rule: no secret in
 * env, ever). The CLI reads it from `--auth-key=file:<path>`, a 0600 file
 * in a private temp dir that is gone once `up` returns (D783).
 */
import * as fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const CANARY = 'tskey-auth-CANARY0000-0123456789abcdefCANARY'

interface Call {
  readonly args: readonly string[]
  readonly opts: { readonly env?: Record<string, string | undefined> }
  readonly fileSeen: string | null
  readonly fileMode: number | null
}
const calls: Call[] = []
let failWith: { message: string; stderr: string } | null = null

vi.mock('node:child_process', () => {
  const execFile = (
    _bin: string,
    args: readonly string[],
    opts: Call['opts'],
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
  ) => {
    const flag = args.find((a) => a.startsWith('--auth-key=file:'))
    const file = flag ? flag.slice('--auth-key=file:'.length) : null
    calls.push({
      args,
      opts,
      fileSeen: file ? fs.readFileSync(file, 'utf8') : null,
      fileMode: file ? fs.statSync(file).mode & 0o777 : null,
    })
    if (failWith && args.includes('up')) {
      // execFile's real message repeats the command line; simulate the worst
      // case where the key is echoed back in both message and stderr.
      const err = Object.assign(new Error(`${failWith.message} ${CANARY}`), {
        stderr: `${failWith.stderr} ${CANARY}`,
      })
      cb(err)
    } else cb(null, { stdout: '', stderr: '' })
  }
  return { execFile, spawn: vi.fn() }
})

const { TailscaleCli: ClientCli } = await import('../client/tailscale-cli.js')
const { TailscaleCli: IngressCli } = await import('../ingress/tailscale-cli.js')

const variants = [
  ['client', () => new ClientCli({ binPath: '/bin/tailscale' })],
  ['ingress', () => new IngressCli({ info: () => undefined } as never)],
] as const

describe.each(variants)('%s TailscaleCli.up', (_name, make) => {
  beforeEach(() => {
    calls.length = 0
    failWith = null
  })

  it('passes the auth key as a 0600 file, never argv or env, and deletes it after', async () => {
    await make().up({ authKey: CANARY, hostname: 'hub' })
    const upCall = calls.find((c) => c.args.includes('up'))!
    expect(upCall.args.join(' ')).not.toContain(CANARY)
    expect(JSON.stringify(upCall.opts ?? {})).not.toContain(CANARY)
    expect(upCall.fileSeen).toBe(CANARY)
    if (process.platform !== 'win32') expect(upCall.fileMode).toBe(0o600)
    const flag = upCall.args.find((a) => a.startsWith('--auth-key=file:'))!
    expect(fs.existsSync(flag.slice('--auth-key=file:'.length))).toBe(false)
  })

  it('a failed up neither leaks the key in the error nor leaves the file behind', async () => {
    failWith = { message: 'Command failed: tailscale up', stderr: 'backend error' }
    const err = await make()
      .up({ authKey: CANARY })
      .then(() => null)
      .catch((e: unknown) => e as Error & { stderr?: string })
    expect(err).not.toBeNull()
    expect(err!.message).not.toContain(CANARY)
    expect(err!.stderr ?? '').not.toContain(CANARY)
    expect(err!.message).toContain('tailscale up failed')
    const flag = calls
      .find((c) => c.args.includes('up'))!
      .args.find((a) => a.startsWith('--auth-key=file:'))!
    expect(fs.existsSync(flag.slice('--auth-key=file:'.length))).toBe(false)
  })
})
