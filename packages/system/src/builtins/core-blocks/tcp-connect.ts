import * as net from 'node:net'
import type { TcpConnect } from '@dominevo/types'

/** Open a TCP connection and close it again: resolves when the port answered, rejects with the reason. */
export const tcpConnect: TcpConnect = (host, port, timeoutMs) =>
  new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port })
    const done = (err?: Error): void => {
      socket.destroy()
      if (err === undefined) resolve()
      else reject(err)
    }
    socket.setTimeout(timeoutMs, () => done(new Error(`timed out after ${timeoutMs / 1000} s`)))
    socket.once('connect', () => done())
    socket.once('error', (err) => done(err))
  })
