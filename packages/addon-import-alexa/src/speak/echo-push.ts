/** What the push channel of an Amazon account tells the Echo devices that poll it. */
export type PushChannelState = 'up' | 'down'

export interface EchoPushSink {
  /** The account's channel went up or down. Called on every change, never repeated. */
  channel(brokerId: string, state: PushChannelState): void
  /** Amazon says something changed on this Echo: read it now. */
  event(brokerId: string, serial: string): void
}
