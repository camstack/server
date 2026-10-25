/**
 * The ONLY surface of the Modal SDK this provider uses (D807).
 *
 * The `modal` JS SDK is beta (pinned at 0.11.0) and has no REST API under it,
 * so every call goes through this interface: `modal-sdk-gateway.ts` is the one
 * file that imports the SDK, and the provider logic plus its contract tests
 * run against a recorded fake. An SDK release that changes a signature breaks
 * `tsc` in that one file, not the provider.
 */
import type { ModalImageRecipe } from './dockerfile.js'

export const MODAL_APP_NAME = 'camstack-training'
export const MODAL_CACHE_VOLUME = 'camstack-training-cache'
/** A small public image with `sh` and `cat`, for the staging / collector sandboxes. */
export const MODAL_TOOLS_IMAGE = 'alpine:3.20'

export type ModalImageSpec =
  | { readonly kind: 'recipe'; readonly recipe: ModalImageRecipe }
  | { readonly kind: 'registry'; readonly tag: string }

export interface ModalSandboxSpec {
  readonly image: ModalImageSpec
  readonly command: readonly string[]
  readonly timeoutMs: number
  readonly gpu?: string
  readonly regions?: readonly string[]
  readonly cpu?: number
  readonly memoryMiB?: number
  /** mount path → volume name (created when missing). */
  readonly volumes: Readonly<Record<string, string>>
  readonly env?: Readonly<Record<string, string>>
  readonly tags: Readonly<Record<string, string>>
  readonly name?: string
}

export interface ModalLogLine {
  readonly ts: number
  readonly text: string
}

export interface ModalSandbox {
  readonly sandboxId: string
  /** `null` while running; the exit code once it ended. */
  poll(): Promise<number | null>
  terminate(): Promise<void>
  /** Persisted entrypoint output since `since` (ms), oldest first. */
  logsSince(since: number): AsyncIterable<ModalLogLine>
  /** Run `command`, streaming `stdin` into it; the exit code. */
  execWithStdin(command: readonly string[], stdin: AsyncIterable<Uint8Array>): Promise<number>
  /** Run `command`; its whole stdout as text, and the exit code. */
  execText(
    command: readonly string[],
  ): Promise<{ readonly exitCode: number; readonly stdout: string }>
  /** Run `command`; its stdout as a byte stream (the caller drains it), then the exit code. */
  execStream(command: readonly string[]): Promise<{
    readonly stdout: AsyncIterable<Uint8Array>
    readonly wait: () => Promise<number>
  }>
}

export interface ModalGateway {
  /** Authenticated round trip; resolves the workspace environment name. */
  checkAuth(): Promise<{ readonly environment: string }>
  createSandbox(spec: ModalSandboxSpec): Promise<ModalSandbox>
  /** `null` when Modal no longer knows the id. */
  sandboxFromId(sandboxId: string): Promise<ModalSandbox | null>
  /** Sandboxes of our app carrying every tag in `tags`. */
  listSandboxes(
    tags: Readonly<Record<string, string>>,
  ): Promise<
    readonly { readonly sandboxId: string; readonly tags: Readonly<Record<string, string>> }[]
  >
  /** Delete a named volume; `false` when it did not exist. */
  deleteVolume(name: string): Promise<boolean>
}

export class ModalAuthError extends Error {
  constructor(
    readonly reason: 'invalid' | 'forbidden' | 'network' | 'quota',
    message: string,
  ) {
    super(message)
    this.name = 'ModalAuthError'
  }
}
