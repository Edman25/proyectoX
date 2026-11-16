/**
 * Globales mínimos de AudioWorklet, para poder cargar `signalsmith-stretch`
 * fuera de un AudioWorklet (en un Worker normal o en Node).
 *
 * El paquete npm solo expone un AudioWorkletNode, pero dentro lleva el WASM
 * del algoritmo. Si al evaluarse encuentra `AudioWorkletProcessor` y
 * `registerProcessor`, registra su clase de procesador: aquí la capturamos
 * y `signalsmith.ts` saca de ella el módulo WASM. DEBE importarse antes que
 * el paquete (los módulos ES se evalúan en orden de importación).
 */
interface FakePort {
  postMessage(message: unknown): void
  onmessage: unknown
}

export interface WorkletProcessorLike {
  port: FakePort
  wasmModule: unknown
}

export type WorkletProcessorClass = new (options: {
  numberOfOutputs: number
  outputChannelCount: number[]
}) => WorkletProcessorLike

const scope = globalThis as unknown as Record<string, unknown>

let captured: WorkletProcessorClass | null = null

/** La clase que registró el paquete, o null si aún no se evaluó. */
export function capturedProcessor(): WorkletProcessorClass | null {
  return captured
}

/** El procesador lee el global `sampleRate` al configurarse. */
export function setWorkletSampleRate(sampleRate: number): void {
  scope['sampleRate'] = sampleRate
}

if (typeof scope['AudioWorkletProcessor'] !== 'function') {
  scope['AudioWorkletProcessor'] = class {
    port: FakePort = { postMessage: () => {}, onmessage: null }
  }
}
if (typeof scope['registerProcessor'] !== 'function') {
  scope['registerProcessor'] = (_name: string, cls: WorkletProcessorClass) => {
    captured = cls
  }
}
