import { ToastService } from '@camstack/system'
import type { Toast } from '@camstack/types'

/**
 * NestJS-injectable wrapper around the core ToastService.
 *
 * Provides toast broadcasting to connected UI clients.
 */
export class ToastServiceWrapper {
  private readonly _service = new ToastService()

  get service(): ToastService {
    return this._service
  }

  broadcast(toast: Toast): void {
    this._service.broadcast(toast)
  }

  sendToUser(userId: string, toast: Toast): void {
    this._service.sendToUser(userId, toast)
  }

  subscribe(connectionId: string, userId: string, callback: (toast: Toast) => void): () => void {
    return this._service.subscribe(connectionId, userId, callback)
  }
}
