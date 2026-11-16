/**
 * Núcleo del stretch: Float32Array[] → Float32Array[], sin Web Audio ni
 * Worker. Cambia duración (`stretchRatio`) y tono (`semitones`) por
 * separado con Signalsmith Stretch.
 *
 * CONFIGURACIÓN: preset por defecto de Signalsmith (bloque de 120 ms, salto
 * de 30 ms), sin `splitComputation` (solo reparte CPU en tiempo real). Se
 * midió el pre-eco de un golpe de ruido sobre una nota grave con bloques de
 * 120, 80, 60 y 40 ms: no hay diferencia (< 0.5 dB) en el ataque, y los
 * bloques cortos pierden resolución en graves. El preset por defecto es el
 * que mejor conserva transientes sin estropear lo tonal.
 *
 * LATENCIA: el algoritmo necesita `inputLatency` muestras por adelantado y
 * entrega con `outputLatency` de retraso. Se compensan las dos: `seek` con
 * el arranque de la entrada como pre-roll, y se descartan las primeras
 * `outputLatency` muestras de salida. El frame 0 de la salida corresponde
 * al frame 0 de la entrada.
 */
import { loadSignalsmith, type StretchModule } from './signalsmith'

export interface StretchParams {
  /** Razón de velocidad: 2 = el doble de rápido (la mitad de largo). */
  stretchRatio: number
  semitones: number
}

export const MIN_STRETCH_RATIO = 0.125
export const MAX_STRETCH_RATIO = 8

/** Frames de salida que se piden por vuelta. */
const CHUNK = 4096
/** Por encima de esta frecuencia no se trata como tonal (valor por defecto de Signalsmith). */
const TONALITY_HZ = 8000

export function stretchedLength(frames: number, stretchRatio: number): number {
  if (frames <= 0) return 0
  return Math.max(1, Math.round(frames / stretchRatio))
}

/** Síncrono, con el módulo ya cargado. No modifica `channels`. */
export function stretchWith(
  module: StretchModule,
  channels: readonly Float32Array[],
  sampleRate: number,
  params: StretchParams,
): Float32Array<ArrayBuffer>[] {
  const { stretchRatio: ratio, semitones } = params
  if (!Number.isFinite(ratio) || ratio < MIN_STRETCH_RATIO || ratio > MAX_STRETCH_RATIO) {
    throw new RangeError(`stretchRatio fuera de rango: ${ratio}`)
  }
  if (!Number.isFinite(semitones)) throw new RangeError(`semitones inválido: ${semitones}`)
  if (!(sampleRate > 0)) throw new RangeError(`sampleRate inválido: ${sampleRate}`)
  const count = channels.length
  const frames = channels[0]?.length ?? 0
  if (count === 0 || frames === 0) return channels.map(() => new Float32Array(0))
  // Nada que hacer: copia exacta, bit a bit.
  if (ratio === 1 && semitones === 0) return channels.map((c) => new Float32Array(c))

  module._presetDefault(count, sampleRate)
  module._reset()
  const inLatency = module._inputLatency()
  const outLatency = module._outputLatency()
  const capacity = Math.max(inLatency, Math.ceil(CHUNK * ratio) + 2, CHUNK)
  const pointer = module._setBuffers(count, capacity)
  module._setTransposeSemitones(semitones, TONALITY_HZ / sampleRate)

  const outFrames = stretchedLength(frames, ratio)
  const out = channels.map(() => new Float32Array(outFrames))

  // Copia entrada[from, from + n) al buffer del WASM, con ceros fuera del audio.
  const feed = (from: number, n: number): void => {
    const heap = module.HEAP8.buffer
    for (let c = 0; c < count; c++) {
      const target = new Float32Array(heap, pointer + capacity * 4 * c, capacity)
      const source = channels[c] as Float32Array
      const available = Math.max(0, Math.min(n, source.length - from))
      if (available > 0) target.set(source.subarray(from, from + available))
      if (available < n) target.fill(0, available, n)
    }
  }

  // Pre-roll: la entrada va `inLatency` muestras por delante de la salida.
  feed(0, inLatency)
  module._seek(inLatency, ratio)
  let fed = inLatency

  const total = outFrames + outLatency
  let done = 0
  while (done < total) {
    const n = Math.min(CHUNK, total - done)
    const need = Math.min(capacity, Math.max(0, inLatency + Math.round((done + n) * ratio) - fed))
    feed(fed, need)
    fed += need
    module._process(need, n)
    // La memoria del WASM puede haber crecido: se vuelve a pedir.
    const heap = module.HEAP8.buffer
    const skip = Math.max(0, outLatency - done)
    if (skip < n) {
      for (let c = 0; c < count; c++) {
        const produced = new Float32Array(heap, pointer + capacity * 4 * (count + c), n)
        ;(out[c] as Float32Array).set(produced.subarray(skip), done + skip - outLatency)
      }
    }
    done += n
  }
  return out
}

/** Carga el WASM (una vez) y procesa. */
export async function stretch(
  channels: readonly Float32Array[],
  sampleRate: number,
  params: StretchParams,
): Promise<Float32Array<ArrayBuffer>[]> {
  return stretchWith(await loadSignalsmith(), channels, sampleRate, params)
}

// --- protocolo del Worker ------------------------------------------------

export interface StretchJob extends StretchParams {
  /** Un Float32Array por canal. Se transfieren: quien llama los pierde. */
  channels: Float32Array[]
  sampleRate: number
}

export interface StretchRequest extends StretchJob {
  id: number
}

export type StretchResponse =
  | { id: number; channels: Float32Array<ArrayBuffer>[] }
  | { id: number; error: string }

/** Lo que hace el Worker con cada mensaje. Aparte para poder probarlo en Node. */
export async function handleStretchRequest(
  request: StretchRequest,
): Promise<{ message: StretchResponse; transfer: ArrayBuffer[] }> {
  try {
    const channels = await stretch(request.channels, request.sampleRate, request)
    return { message: { id: request.id, channels }, transfer: channels.map((c) => c.buffer) }
  } catch (err) {
    return { message: { id: request.id, error: err instanceof Error ? err.message : String(err) }, transfer: [] }
  }
}
