/**
 * Carga el WASM de Signalsmith Stretch (paquete npm `signalsmith-stretch`,
 * MIT) para usarlo offline, sin AudioWorklet. Ver `workletShim.ts`.
 *
 * Este archivo solo debe importarse desde el Worker de stretch o desde
 * tests: en el hilo principal dejaría globales falsos de AudioWorklet.
 */
// El orden de estos dos imports importa.
import { capturedProcessor, setWorkletSampleRate } from './workletShim'
import 'signalsmith-stretch'

/** Las funciones exportadas por el WASM (build 1.3.2). */
export interface StretchModule {
  HEAP8: Int8Array
  /** Reserva entrada + salida; devuelve el puntero al primer canal de entrada. */
  _setBuffers(channels: number, length: number): number
  _presetDefault(channels: number, sampleRate: number): void
  _presetCheaper(channels: number, sampleRate: number): void
  _configure(channels: number, blockSamples: number, intervalSamples: number, splitComputation: boolean): void
  _reset(): void
  _inputLatency(): number
  _outputLatency(): number
  _setTransposeSemitones(semitones: number, tonalityLimit: number): void
  /** Declara `inputSamples` de entrada previa (pre-roll) sin producir salida. */
  _seek(inputSamples: number, playbackRate: number): void
  _process(inputSamples: number, outputSamples: number): void
  _flush(outputSamples: number): void
}

let loading: Promise<StretchModule> | null = null

export function loadSignalsmith(): Promise<StretchModule> {
  loading ??= new Promise<StretchModule>((resolve, reject) => {
    const Processor = capturedProcessor()
    if (!Processor) {
      reject(new Error('signalsmith-stretch no registró su procesador (¿cambió la versión del paquete?)'))
      return
    }
    setWorkletSampleRate(48000)
    const processor = new Processor({ numberOfOutputs: 1, outputChannelCount: [2] })
    const timeout = setTimeout(() => reject(new Error('signalsmith-stretch: el WASM no arrancó')), 10000)
    // Cuando el WASM está instanciado, el procesador avisa por su puerto.
    processor.port.postMessage = (message) => {
      if (!Array.isArray(message) || message[0] !== 'ready') return
      clearTimeout(timeout)
      const module = processor.wasmModule as StretchModule | null
      if (module && typeof module._process === 'function' && typeof module._seek === 'function') resolve(module)
      else reject(new Error('signalsmith-stretch: módulo WASM con forma inesperada'))
    }
  })
  return loading
}
