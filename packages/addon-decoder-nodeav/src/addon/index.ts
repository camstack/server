import type {
  DecoderHwAccelConfig,
  IDecoderCapProvider,
  ProviderRegistration,
} from '@camstack/types'
import {
  audioCodecCapability,
  BaseAddon,
  DEFAULT_DECODER_HWACCEL_CONFIG,
  decoderCapability,
  HWACCEL_OPTIONS,
} from '@camstack/types'
import { rankDecodeHwAccels } from '../decode-hwaccel-rank.js'
import { NodeAvAudioCodecProvider } from '../audio-codec/provider.js'
import { loadNodeAvRuntime, type NodeAvRuntime } from '../audio-codec/nodeav-runtime-loader.js'

/**
 * The node's `decoder` + `audio-codec` provider.
 *
 * The `decoder` cap is per-node hwaccel only (D763): `getInfo` reports this
 * node's operator choice and probed best backend, `reprobeHwaccel` re-runs the
 * probe. Both are per-node settings (`hwaccel@<node>`,
 * `probedBestHwaccel@<node>`); the egress transcode, HomeKit and the load view
 * read them through `getInfo`, pinned to the node. Video decoding itself runs in the pipeline runner's session-decode
 * workers, which use node-av directly. The `audio-codec` cap is the node-av
 * codec (encode/decode + resample) every audio session on the node runs on.
 */
export default class DecoderNodeAvAddon
  extends BaseAddon<DecoderHwAccelConfig>
  implements IDecoderCapProvider
{
  /**
   * node-av audio-codec provider — registered whenever node-av loads on this
   * node, so this single addon provides both the `decoder` and `audio-codec`
   * caps.
   */
  private audioProvider: NodeAvAudioCodecProvider | null = null

  constructor() {
    super(DEFAULT_DECODER_HWACCEL_CONFIG)
  }

  protected globalSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: 'hwaccel',
          title: 'Hardware acceleration',
          tab: 'decoder',
          description:
            'Decode hwaccel this node reports through decoder.getInfo — read by the egress transcode and HomeKit. "Auto" defers to the probed best; concrete backends force it. Changes apply to NEW transcodes.',
          fields: [
            this.field({
              type: 'select',
              key: 'hwaccel',
              label: 'Preferred backend',
              options: [...HWACCEL_OPTIONS],
              default: 'auto',
              immediate: true,
              // Per-node override — hardware differs per node, so the operator's
              // forced backend is scoped `hwaccel@<node>`, not one global value.
              perNode: true,
            }),
            this.field({
              type: 'text',
              key: 'probedBestHwaccel',
              label: 'Probed best',
              description:
                'Auto-detected best decoder backend on this host. Click the refresh icon to re-run the probe.',
              readonlyField: true,
              default: '',
              perNode: true,
              actions: [
                { action: 'reprobe-hwaccel', icon: 'refresh-cw', tooltip: 'Re-probe hwaccel' },
              ],
            }),
          ],
        },
      ],
    })
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const registrations: ProviderRegistration[] = []

    // ── audio-codec cap ──────────────────────────────────────────────────
    // Load the shared node-av runtime ONCE here — audio sessions then construct
    // synchronously. If node-av cannot load, this node has no audio-codec
    // provider, and the failure is logged as an error.
    let runtime: NodeAvRuntime | null = null
    try {
      runtime = await loadNodeAvRuntime()
    } catch (err) {
      this.ctx.logger.error('decoder-nodeav: node-av failed to load — no audio-codec provider', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
    if (runtime) {
      this.audioProvider = new NodeAvAudioCodecProvider({
        logger: this.ctx.logger,
        runtime,
        resolveLocalNodeId: () => this.resolveLocalNodeId(),
      })
      this.audioProvider.start()
      registrations.push({ capability: audioCodecCapability, provider: this.audioProvider })
    }

    // ── decoder cap ──────────────────────────────────────────────────────
    // Per-node hwaccel only (D763). Registered on every node: this addon is the
    // only `decoder` provider since the ffmpeg-subprocess fallback was deleted.
    this.ctx.logger.info('node-av decoder addon initialized')
    // Auto-seed probedBestHwaccel on first boot so the UI can show
    // the node's best backend without waiting for an operator click.
    if (!this.config.probedBestHwaccel) {
      this.reprobeHwaccel().catch((err: unknown) => {
        this.ctx.logger.warn('nodeav: auto-reprobe hwaccel failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
    registrations.push({ capability: decoderCapability, provider: this })
    return registrations
  }

  /**
   * Re-run the platform probe on this host and persist the detected
   * backend as `probedBestHwaccel`. The operator's `hwaccel` setting
   * is intentionally left alone — the probe only updates the hint.
   */
  async reprobeHwaccel(): Promise<{ backend: string }> {
    const resolver = this.ctx.kernel.hwaccel
    if (!resolver) {
      this.ctx.logger.warn('reprobeHwaccel: no kernel hwaccel resolver — returning none')
      await this.updateGlobalSettings({ probedBestHwaccel: 'none' })
      return { backend: 'none' }
    }
    try {
      const res = await resolver.resolve()
      // The ACTUAL decode-backend head (vaapi ranked above qsv), not the raw
      // `preferred[0]` — so the per-node `probedBestHwaccel` the UI shows matches
      // the backend sessions run on.
      const backend = rankDecodeHwAccels(res.preferred, [])[0] ?? 'none'
      // `probedBestHwaccel` is `perNode: true` — the base scopes this write to
      // `probedBestHwaccel@<localNode>` (node-blind), never the bare key, and
      // refreshes `this.config` + emits the addon-updated event.
      await this.updateGlobalSettings({ probedBestHwaccel: backend })
      this.ctx.logger.info('reprobeHwaccel: wrote probedBestHwaccel', {
        meta: { backend, rationale: res.rationale, preferred: res.preferred },
      })
      return { backend }
    } catch (err) {
      this.ctx.logger.warn('reprobeHwaccel failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      await this.updateGlobalSettings({ probedBestHwaccel: 'none' })
      return { backend: 'none' }
    }
  }

  async getInfo(): Promise<{
    id: string
    name: string
    hwaccel?: string
    probedBestHwaccel?: string
  }> {
    return {
      id: 'decoder-nodeav',
      name: 'Decoder (node-av)',
      // Active decode hwaccel state (per-node projected) — the orchestrator
      // reads this via the `decoder` cap (nodePin), not an addon-id lookup.
      hwaccel: this.config.hwaccel,
      probedBestHwaccel: this.config.probedBestHwaccel || undefined,
    }
  }

  /**
   * The cluster node id of this addon — the Moleculer nodeID (`hub`,
   * `dev-agent-0`, …), not the addon id. A hierarchical broker nodeID
   * (`hub/...`) is collapsed to the cluster-visible parent; in-process boot is
   * left as-is. Mirrors the resolution `PipelineRunnerAddon.onInitialize`
   * performs.
   */
  private resolveLocalNodeId(): string {
    const raw = this.ctx.kernel.localNodeId ?? this.ctx.id
    return raw.includes('/') ? raw.split('/')[0]! : raw
  }

  protected async onShutdown(): Promise<void> {
    // Tear down the audio-codec provider (reaper + native sessions).
    this.audioProvider?.stop()
    this.audioProvider = null
    this.ctx.logger.info('node-av decoder addon shutdown')
  }
}
