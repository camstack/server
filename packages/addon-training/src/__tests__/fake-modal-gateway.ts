/**
 * A recorded fake of {@link ModalGateway}: Volumes are in-memory file maps,
 * sandboxes run the handful of shell commands the provider issues (and
 * REFUSE any other, so a provider change that sends a new command fails
 * here before it runs against Modal), and the trainer sandbox finishes when
 * the test says so.
 */
import type {
  ModalGateway,
  ModalLogLine,
  ModalSandbox,
  ModalSandboxSpec,
} from '../providers/modal/modal-gateway.js'

type Volume = Map<string, Buffer>

interface FakeSandbox {
  readonly id: string
  readonly spec: ModalSandboxSpec
  exitCode: number | null
  readonly logs: ModalLogLine[]
}

export class FakeModalGateway implements ModalGateway {
  readonly volumes = new Map<string, Volume>()
  readonly sandboxes = new Map<string, FakeSandbox>()
  readonly calls: string[] = []
  authError: Error | null = null
  private n = 0

  constructor(private readonly now: () => number) {}

  /** The trainer writes its outputs and exits. */
  finishTrainer(
    jobKey: string,
    outputs: Record<string, Buffer>,
    exitCode = 0,
    logs: readonly string[] = [],
  ): void {
    const sb = [...this.sandboxes.values()].find(
      (s) => s.spec.tags['jobKey'] === jobKey && s.spec.tags['role'] === 'trainer',
    )
    if (sb === undefined) throw new Error(`no trainer sandbox for ${jobKey}`)
    const vol = this.volume(sb.spec.volumes['/data'] ?? '')
    for (const [path, body] of Object.entries(outputs)) vol.set(path, body)
    for (const text of logs) sb.logs.push({ ts: this.now(), text })
    sb.exitCode = exitCode
  }

  trainerSpec(jobKey: string): ModalSandboxSpec | undefined {
    return [...this.sandboxes.values()].find(
      (s) => s.spec.tags['jobKey'] === jobKey && s.spec.tags['role'] === 'trainer',
    )?.spec
  }

  async checkAuth(): Promise<{ environment: string }> {
    if (this.authError !== null) throw this.authError
    return { environment: 'main' }
  }

  async createSandbox(spec: ModalSandboxSpec): Promise<ModalSandbox> {
    this.n += 1
    const id = `sb-${String(this.n)}`
    for (const name of Object.values(spec.volumes)) this.volume(name)
    this.sandboxes.set(id, { id, spec, exitCode: null, logs: [] })
    this.calls.push(`create:${spec.tags['role'] ?? '?'}`)
    return this.handle(id)
  }

  async sandboxFromId(sandboxId: string): Promise<ModalSandbox | null> {
    return this.sandboxes.has(sandboxId) ? this.handle(sandboxId) : null
  }

  async listSandboxes(tags: Readonly<Record<string, string>>) {
    return [...this.sandboxes.values()]
      .filter(
        (s) => s.exitCode === null && Object.entries(tags).every(([k, v]) => s.spec.tags[k] === v),
      )
      .map((s) => ({ sandboxId: s.id, tags: s.spec.tags }))
  }

  async deleteVolume(name: string): Promise<boolean> {
    this.calls.push(`delete-volume:${name}`)
    return this.volumes.delete(name)
  }

  private volume(name: string): Volume {
    const existing = this.volumes.get(name)
    if (existing !== undefined) return existing
    const created: Volume = new Map()
    this.volumes.set(name, created)
    return created
  }

  private handle(id: string): ModalSandbox {
    const sb = (): FakeSandbox => {
      const found = this.sandboxes.get(id)
      if (found === undefined) throw new Error(`sandbox ${id} vanished`)
      return found
    }
    const data = (): Volume => this.volume(sb().spec.volumes['/data'] ?? '')
    return {
      sandboxId: id,
      poll: async () => sb().exitCode,
      terminate: async () => {
        if (sb().exitCode === null) sb().exitCode = 137
      },
      logsSince: async function* (since: number) {
        for (const line of sb().logs) if (line.ts >= since) yield line
      },
      execWithStdin: async (command, stdin) => {
        if (
          command.at(-1) !==
          'cat > /data/dataset.tar.part && mv /data/dataset.tar.part /data/dataset.tar && sync'
        ) {
          throw new Error(`fake gateway: unexpected stdin command ${command.join(' ')}`)
        }
        const chunks: Buffer[] = []
        for await (const c of stdin) chunks.push(Buffer.from(c))
        data().set('dataset.tar', Buffer.concat(chunks))
        return 0
      },
      execText: async (command) => {
        if (command.at(-1) !== 'cat /data/out/result.json 2>/dev/null || true') {
          throw new Error(`fake gateway: unexpected text command ${command.join(' ')}`)
        }
        return { exitCode: 0, stdout: data().get('out/result.json')?.toString('utf8') ?? '' }
      },
      execStream: async (command) => {
        const path = command[1]?.replace('/data/', '') ?? ''
        if (command[0] !== 'cat' || !data().has(path))
          throw new Error(`fake gateway: cannot stream ${command.join(' ')}`)
        const body = data().get(path) ?? Buffer.alloc(0)
        return {
          stdout: (async function* () {
            yield body
          })(),
          wait: async () => 0,
        }
      },
    }
  }
}
