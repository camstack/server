/**
 * {@link ModalGateway} over the official `modal` JS SDK — the ONE file that
 * imports it (pinned 0.11.0, beta; D807). Everything SDK-specific stays here:
 * the client, the app, image building from a recipe, volume lookup, error
 * classification. The credentials come from the addon's keychain-backed
 * settings and are handed to the client constructor only — never to an
 * environment variable, never to a log line.
 */
import {
  type App,
  type Image,
  ModalClient,
  NotFoundError,
  type Sandbox,
  type SandboxCreateParams,
  type Volume,
} from 'modal'
import {
  MODAL_APP_NAME,
  ModalAuthError,
  type ModalGateway,
  type ModalImageSpec,
  type ModalLogLine,
  type ModalSandbox,
  type ModalSandboxSpec,
} from './modal-gateway.js'

export interface ModalCredentials {
  readonly tokenId: string
  readonly tokenSecret: string
  /** Modal environment; `''` = the workspace default. */
  readonly environment: string
}

function classify(err: unknown): Error {
  const text = err instanceof Error ? err.message : String(err)
  if (/unauthenticated|invalid token|token.*(not found|invalid)|401/i.test(text)) {
    return new ModalAuthError('invalid', 'Modal rejected the token id/secret')
  }
  if (/permission|forbidden|403/i.test(text)) return new ModalAuthError('forbidden', text)
  if (/quota|resource.?exhausted|billing|limit/i.test(text))
    return new ModalAuthError('quota', text)
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|unavailable|deadline/i.test(text))
    return new ModalAuthError('network', text)
  return err instanceof Error ? err : new Error(text)
}

async function* toBytes(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

class SdkSandbox implements ModalSandbox {
  constructor(private readonly sb: Sandbox) {}

  get sandboxId(): string {
    return this.sb.sandboxId
  }

  poll(): Promise<number | null> {
    return this.sb.poll()
  }

  async terminate(): Promise<void> {
    await this.sb.terminate()
  }

  async *logsSince(since: number): AsyncIterable<ModalLogLine> {
    for await (const entry of this.sb.logs.fetch({ since: new Date(since) })) {
      yield { ts: entry.timestamp.getTime(), text: entry.message }
    }
  }

  async execWithStdin(
    command: readonly string[],
    stdin: AsyncIterable<Uint8Array>,
  ): Promise<number> {
    const proc = await this.sb.exec([...command], {
      mode: 'binary',
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const writer = proc.stdin.getWriter()
    try {
      for await (const chunk of stdin) await writer.write(chunk)
      await writer.close()
    } catch (err: unknown) {
      await writer.abort(err).catch(() => undefined)
      throw err
    }
    return proc.wait()
  }

  async execText(command: readonly string[]): Promise<{ exitCode: number; stdout: string }> {
    const proc = await this.sb.exec([...command], {
      mode: 'text',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const stdout = await proc.stdout.readText()
    return { exitCode: await proc.wait(), stdout }
  }

  async execStream(command: readonly string[]) {
    const proc = await this.sb.exec([...command], {
      mode: 'binary',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    return { stdout: toBytes(proc.stdout), wait: () => proc.wait() }
  }
}

export class ModalSdkGateway implements ModalGateway {
  private readonly client: ModalClient
  private app: App | null = null

  constructor(private readonly credentials: ModalCredentials) {
    this.client = new ModalClient({
      tokenId: credentials.tokenId,
      tokenSecret: credentials.tokenSecret,
      ...(credentials.environment !== '' ? { environment: credentials.environment } : {}),
    })
  }

  close(): void {
    this.client.close()
  }

  async checkAuth(): Promise<{ environment: string }> {
    try {
      await this.requireApp()
      return { environment: this.client.environmentName(this.credentials.environment || undefined) }
    } catch (err: unknown) {
      throw classify(err)
    }
  }

  async createSandbox(spec: ModalSandboxSpec): Promise<ModalSandbox> {
    try {
      const app = await this.requireApp()
      const volumes: Record<string, Volume> = {}
      for (const [mount, name] of Object.entries(spec.volumes)) {
        volumes[mount] = await this.client.volumes.fromName(name, { createIfMissing: true })
      }
      const params: SandboxCreateParams = {
        command: [...spec.command],
        timeoutMs: spec.timeoutMs,
        volumes,
        tags: { ...spec.tags },
        ...(spec.gpu !== undefined ? { gpu: spec.gpu } : {}),
        ...(spec.regions !== undefined ? { regions: [...spec.regions] } : {}),
        ...(spec.cpu !== undefined ? { cpu: spec.cpu } : {}),
        ...(spec.memoryMiB !== undefined ? { memoryMiB: spec.memoryMiB } : {}),
        ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
        ...(spec.name !== undefined ? { name: spec.name } : {}),
      }
      const sb = await this.client.sandboxes.create(app, this.image(spec.image), params)
      return new SdkSandbox(sb)
    } catch (err: unknown) {
      throw classify(err)
    }
  }

  async sandboxFromId(sandboxId: string): Promise<ModalSandbox | null> {
    try {
      return new SdkSandbox(await this.client.sandboxes.fromId(sandboxId))
    } catch (err: unknown) {
      if (err instanceof NotFoundError) return null
      throw classify(err)
    }
  }

  async listSandboxes(tags: Readonly<Record<string, string>>) {
    const app = await this.requireApp()
    const out: { sandboxId: string; tags: Record<string, string> }[] = []
    for await (const sb of this.client.sandboxes.list({ appId: app.appId, tags: { ...tags } })) {
      out.push({ sandboxId: sb.sandboxId, tags: await sb.getTags() })
    }
    return out
  }

  async deleteVolume(name: string): Promise<boolean> {
    try {
      await this.client.volumes.fromName(name)
    } catch (err: unknown) {
      if (err instanceof NotFoundError) return false
      throw classify(err)
    }
    await this.client.volumes.delete(name, { allowMissing: true })
    return true
  }

  private async requireApp(): Promise<App> {
    if (this.app === null) {
      this.app = await this.client.apps.fromName(MODAL_APP_NAME, { createIfMissing: true })
    }
    return this.app
  }

  private image(spec: ModalImageSpec): Image {
    if (spec.kind === 'registry') return this.client.images.fromRegistry(spec.tag)
    return this.client.images
      .fromRegistry(spec.recipe.from)
      .dockerfileCommands([...spec.recipe.commands])
  }
}
