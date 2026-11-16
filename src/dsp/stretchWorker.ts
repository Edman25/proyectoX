/**
 * Worker de stretch: recibe StretchRequest, responde StretchResponse.
 * Los mensajes se atienden de uno en uno, en orden de llegada. Los buffers
 * viajan transferidos en los dos sentidos (sin copia).
 */
import { handleStretchRequest, type StretchRequest, type StretchResponse } from './stretchCore'

interface WorkerScope {
  onmessage: ((event: MessageEvent<StretchRequest>) => void) | null
  postMessage(message: StretchResponse, transfer: Transferable[]): void
}

const scope = self as unknown as WorkerScope

let queue: Promise<void> = Promise.resolve()

scope.onmessage = (event) => {
  const request = event.data
  queue = queue.then(async () => {
    const { message, transfer } = await handleStretchRequest(request)
    scope.postMessage(message, transfer)
  })
}
