/** The real {@link PassiveListenIo}: two multicast UDP sockets. Not unit-tested; the watcher is. */
import { createSocket, type Socket } from 'node:dgram'
import type { PassiveListenIo, PassivePacket } from './discovery-watcher.js'
import { MDNS_GROUP, MDNS_PORT } from '../scan/dns-wire.js'

const SSDP_GROUP = '239.255.255.250'
const SSDP_PORT = 1900

function listenOn(
  protocol: PassivePacket['protocol'],
  port: number,
  group: string,
  onPacket: (packet: PassivePacket) => void,
  onError: (protocol: PassivePacket['protocol'], error: Error) => void,
): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('error', (err) => {
      onError(protocol, err)
      try {
        socket.close()
      } catch {
        // already closed
      }
      resolve(null)
    })
    socket.on('message', (data, rinfo) => onPacket({ protocol, data, from: rinfo.address }))
    socket.bind(port, () => {
      try {
        socket.addMembership(group)
        resolve(socket)
      } catch (err) {
        onError(protocol, err instanceof Error ? err : new Error(String(err)))
        socket.close()
        resolve(null)
      }
    })
  })
}

export const nodePassiveListenIo: PassiveListenIo = {
  async open(onPacket, onError) {
    const sockets = (
      await Promise.all([
        listenOn('mdns', MDNS_PORT, MDNS_GROUP, onPacket, onError),
        listenOn('ssdp', SSDP_PORT, SSDP_GROUP, onPacket, onError),
      ])
    ).filter((s): s is Socket => s !== null)
    return {
      close: () => {
        for (const s of sockets) {
          try {
            s.close()
          } catch {
            // already closed
          }
        }
      },
    }
  },
}
