/** Duplex that carries Home Connect JSON text frames (WebSocket payload or test fake). */
export interface HomeConnectWire {
  connect(): Promise<void>
  send(text: string): void
  close(): void
  readonly open: boolean
  onText(listener: (text: string) => void): () => void
  onClosed(listener: () => void): () => void
}

export type HomeConnectWireFactory = (input: {
  readonly host: string
  readonly connectAddress: string
  readonly psk: string
  readonly mode: 'TLS' | 'AES'
  readonly iv64?: string
}) => HomeConnectWire
