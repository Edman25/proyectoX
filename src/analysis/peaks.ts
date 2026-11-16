/**
 * Picos para dibujar la forma de onda. Se calcula una vez un nivel base
 * (min/max cada BASE_BUCKET frames) y de ahí se agrega para cualquier zoom.
 */

export const BASE_BUCKET = 128

export interface Peaks {
  /** Frames por bucket del nivel base. */
  bucket: number
  min: Float32Array
  max: Float32Array
  frames: number
}

/** Mezcla a mono promediando canales. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0]
  if (!first) return new Float32Array(0)
  if (channels.length === 1) return first
  const out = new Float32Array(first.length)
  for (const ch of channels) {
    for (let i = 0; i < out.length; i++) out[i]! += ch[i]! / channels.length
  }
  return out
}

export function computePeaks(mono: Float32Array, bucket = BASE_BUCKET): Peaks {
  const n = Math.ceil(mono.length / bucket)
  const min = new Float32Array(n)
  const max = new Float32Array(n)
  for (let b = 0; b < n; b++) {
    let lo = 0
    let hi = 0
    const end = Math.min(mono.length, (b + 1) * bucket)
    for (let i = b * bucket; i < end; i++) {
      const v = mono[i]!
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    min[b] = lo
    max[b] = hi
  }
  return { bucket, min, max, frames: mono.length }
}

/**
 * Min/max por columna de píxel para mostrar [startFrame, endFrame) en `width`
 * columnas. Cuando hay menos de un bucket por columna, repite el bucket.
 */
export function peaksForView(
  peaks: Peaks,
  startFrame: number,
  endFrame: number,
  width: number,
): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(width)
  const max = new Float32Array(width)
  const framesPerPx = (endFrame - startFrame) / width
  for (let x = 0; x < width; x++) {
    const f0 = startFrame + x * framesPerPx
    const f1 = f0 + framesPerPx
    const b0 = Math.max(0, Math.floor(f0 / peaks.bucket))
    const b1 = Math.min(peaks.min.length, Math.max(b0 + 1, Math.ceil(f1 / peaks.bucket)))
    let lo = 0
    let hi = 0
    for (let b = b0; b < b1; b++) {
      if (peaks.min[b]! < lo) lo = peaks.min[b]!
      if (peaks.max[b]! > hi) hi = peaks.max[b]!
    }
    min[x] = lo
    max[x] = hi
  }
  return { min, max }
}
