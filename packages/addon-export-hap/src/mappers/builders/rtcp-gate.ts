/**
 * Return-path gate for one SRTP leg.
 *
 * iOS 15.5+ will not display a stream whose return path it has not validated,
 * so the loopback forwarder holds the first encrypted packet until either the
 * controller probes our advertised port or a short fallback fires.
 *
 * The two outcomes mean opposite things and MUST be distinguishable:
 *
 *   - `packet`  — the controller found us. Everything downstream of here is a
 *                 media problem, not a routing problem.
 *   - `timeout` — nothing ever arrived on the port we advertised. Media is
 *                 leaving into a port that may have no listener; the interface
 *                 pick, the NAT path or the advertised port is the suspect.
 *
 * Before this split both resolved a bare `Promise<void>` and the logs recorded
 * neither, which is why "does iOS's RTCP reach our video return port at all?"
 * stayed an open question through the whole 31 s-teardown investigation.
 *
 * The gate NEVER tears a session down. It only reports. (Both mainstream
 * open-source HomeKit camera stacks arm an idle watchdog that kills the stream
 * at 30 s; this accessory deliberately has none, and adding one here while
 * chasing a 31 s teardown would be an own goal.)
 */

/** Structural slice of `dgram.Socket` the gate needs — keeps it unit-testable. */
export interface RtcpGateSocket {
  on(event: 'message', listener: () => void): unknown
  removeListener(event: 'message', listener: () => void): unknown
}

export type RtcpGateReason = 'packet' | 'timeout'

export interface RtcpGateResolution {
  readonly reason: RtcpGateReason
  /** Milliseconds between arming the gate and its resolution. */
  readonly waitedMs: number
}

/** `packet@42ms` / `timeout@1000ms` — one compact log field. */
export function formatRtcpGate(resolution: RtcpGateResolution | null): string {
  if (resolution === null) return 'pending'
  return `${resolution.reason}@${resolution.waitedMs}ms`
}

/**
 * Resolve as soon as ANY packet arrives on `socket`, or after `timeoutMs`.
 * One-shot: the listener is detached on either path.
 */
export function makeRtcpGate(
  socket: RtcpGateSocket,
  timeoutMs: number,
): Promise<RtcpGateResolution> {
  const armedAt = Date.now()
  return new Promise<RtcpGateResolution>((resolve) => {
    const onMessage = (): void => {
      socket.removeListener('message', onMessage)
      clearTimeout(timer)
      resolve({ reason: 'packet', waitedMs: Date.now() - armedAt })
    }
    const timer = setTimeout(() => {
      socket.removeListener('message', onMessage)
      resolve({ reason: 'timeout', waitedMs: Date.now() - armedAt })
    }, timeoutMs)
    socket.on('message', onMessage)
  })
}
