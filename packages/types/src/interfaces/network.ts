export interface NetworkAddress {
  readonly host: string
  readonly port: number
  readonly protocol: 'http' | 'https'
}

export interface PublicAddress {
  readonly url: string
  readonly provider: string
}

export interface INetworkProvider {
  getLocalAddress(): NetworkAddress
  getPublicAddress(): PublicAddress | null
  registerRemoteAccess(provider: IRemoteAccessProvider): void
  unregisterRemoteAccess(providerId: string): void
  onPublicAddressChange(callback: (address: PublicAddress | null) => void): () => void
}

export type RemoteAccessStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

export interface IRemoteAccessProvider {
  readonly id: string
  readonly name: string
  getPublicUrl(): string | null
  getStatus(): RemoteAccessStatus
  start(): Promise<void>
  stop(): Promise<void>
  onStatusChange?(callback: (status: RemoteAccessStatus) => void): () => void
}

// Legacy `ITurnProvider` / `TurnCredentials` / `TurnServer` interfaces were
// removed — TURN/STUN routing now flows entirely through the `turn-provider`
// capability defined in `capabilities/turn-provider.cap.ts`. The interface
// stubs here predated the capability system and were never consumed.
