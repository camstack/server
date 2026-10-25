/**
 * Regression: the addon's onShutdown MUST tear down the WebRTC server, not
 * just the brokers. A graceful runner respawn (deploy) that leaves werift
 * PeerConnections (and their ICE UDP sockets) open leaks those sockets past
 * process exit and wedges the freshly respawned runner's ICE agent — DTLS
 * then never connects on any camera until a full hub restart.
 */
import { describe, it, expect, vi } from 'vitest'
import { StreamBrokerAddon } from '../addon.js'

describe('StreamBrokerAddon.onShutdown', () => {
  it('stops the WebRTC server (releases ICE UDP sockets) and destroys brokers', async () => {
    const addon = new StreamBrokerAddon()
    const stop = vi.fn().mockResolvedValue(undefined)
    const destroyAll = vi.fn().mockResolvedValue(undefined)

    // Inject the collaborators the way onInitialize would have.
    Object.assign(addon as unknown as Record<string, unknown>, {
      webrtcServer: { stop },
      brokerManager: { destroyAll },
    })

    await (addon as unknown as { onShutdown(): Promise<void> }).onShutdown()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(destroyAll).toHaveBeenCalledTimes(1)
  })

  it('does not throw when there is no WebRTC server (never initialized)', async () => {
    const addon = new StreamBrokerAddon()
    await expect(
      (addon as unknown as { onShutdown(): Promise<void> }).onShutdown(),
    ).resolves.toBeUndefined()
  })
})
