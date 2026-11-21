/**
 * What every toolset of `camstack mcp` is handed. Tests inject a fake hub
 * connection and a fake registry; production wires the CLI's credential chain.
 */
import type { ConnectOutcome, HubConnection, HubDownloader, MutationGate } from '@camstack/develop'
import type { HostCheckReport } from '../host-check/host-check.js'
import type { HostFacts } from '../host-check/sizing.js'
import type { ManifestProvider } from '../onboarding/manifest.js'
import type { OnboardingStateStore } from '../onboarding/state-file.js'

export interface ToolTextResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: true
}

/** Resolves the hub for ONE tool call. Never throws for a missing login. */
export type HubProvider = () => Promise<ConnectOutcome>

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

/** The machine this process runs on, as the onboarding tools read it. */
export interface HostProbe {
  check(): HostCheckReport
  /** `diskPath`: the volume recordings would go to, or null to skip the disk. */
  facts(diskPath: string | null): HostFacts
}

export interface McpContext {
  /** The running `camstack` CLI version. */
  readonly cliVersion: string
  readonly hub: HubProvider
  readonly gate: MutationGate
  readonly fetch: FetchFn
  /** Streams a hub data-plane path to a file; absent means the real HTTP downloader. */
  readonly downloader?: (connection: HubConnection) => HubDownloader
  /** Where exports land; absent means `~/.camstack/exports`. */
  readonly exportDir?: string
  /** The onboarding manifest; absent means the snapshot bundled in this CLI. */
  readonly manifest?: ManifestProvider
  /** Absent means the real machine. */
  readonly host?: HostProbe
  /** Absent means `~/.camstack/onboarding.json`. */
  readonly onboardingState?: OnboardingStateStore
  /** The names of the tools this server registered; absent means not known. */
  readonly registeredTools?: () => ReadonlySet<string>
}
