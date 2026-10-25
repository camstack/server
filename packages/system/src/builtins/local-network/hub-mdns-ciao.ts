/**
 * The real mDNS responder behind {@link HubMdnsPublisher}: `@homebridge/ciao`.
 * Loaded lazily so a host without multicast support only pays on advertise,
 * and a load failure surfaces as an advertise failure (logged, never fatal).
 */
import type { HubMdnsAnnouncement, HubMdnsHandle, HubMdnsPublisher } from './hub-mdns.js'

export function createCiaoPublisher(): HubMdnsPublisher {
  return {
    async publish(announcement: HubMdnsAnnouncement): Promise<HubMdnsHandle> {
      const { getResponder } = await import('@homebridge/ciao')
      const responder = getResponder()
      const service = responder.createService({
        name: announcement.name,
        type: announcement.type,
        port: announcement.port,
        txt: { ...announcement.txt },
        ...(announcement.address !== null ? { restrictedAddresses: [announcement.address] } : {}),
      })
      try {
        await service.advertise()
      } catch (err: unknown) {
        await responder.shutdown().catch(() => undefined)
        throw err
      }
      return {
        stop: async () => {
          await service.destroy()
          await responder.shutdown()
        },
      }
    },
  }
}
