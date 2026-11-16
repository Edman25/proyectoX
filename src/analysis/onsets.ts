/**
 * Detección de transientes (golpes) para cortar automáticamente.
 *
 * Método: envolvente de energía en ventanas cortas → diferencia del log de
 * energía (cuánto "sube" de golpe) con una fracción realzada de agudos →
 * umbral adaptativo (mediana local) → picos con separación mínima → cada
 * golpe se retrocede hasta donde empieza a subir la energía.
 */

export interface OnsetOptions {
  sampleRate: number
  /** 0 (solo golpes muy claros) a 1 (todo lo que suba un poco). */
  sensitivity: number
  /** Separación mínima entre golpes. */
  minGapMs?: number
  /** Tamaño de salto entre ventanas. */
  hop?: number
}

export function detectOnsets(mono: Float32Array, opts: OnsetOptions): number[] {
  const hop = opts.hop ?? 256
  const win = hop * 2
  const minGap = Math.max(1, Math.round(((opts.minGapMs ?? 60) / 1000) * opts.sampleRate / hop))
  const nFrames = Math.floor(Math.max(0, mono.length - win) / hop) + 1
  if (mono.length < win) return []

  // Energía por ventana, con un realce simple de agudos (diferencia de primer orden).
  const energy = new Float32Array(nFrames)
  for (let f = 0; f < nFrames; f++) {
    const start = f * hop
    let e = 0
    let prev = mono[start]!
    for (let i = start; i < start + win; i++) {
      const v = mono[i]!
      const hp = v - prev
      prev = v
      e += v * v + 4 * hp * hp
    }
    energy[f] = Math.log10(1e-10 + e / win)
  }

  // Novedad: solo subidas.
  const novelty = new Float32Array(nFrames)
  for (let f = 1; f < nFrames; f++) novelty[f] = Math.max(0, energy[f]! - energy[f - 1]!)

  // Umbral: mediana local + margen que baja con la sensibilidad.
  const s = Math.min(1, Math.max(0, opts.sensitivity))
  const margin = 0.05 + (1 - s) * 0.6
  const half = 8
  const peaks: number[] = []
  let last = -Infinity
  for (let f = 1; f < nFrames - 1; f++) {
    const v = novelty[f]!
    if (v < novelty[f - 1]! || v < novelty[f + 1]!) continue
    const lo = Math.max(0, f - half)
    const hi = Math.min(nFrames, f + half + 1)
    const local = Array.from(novelty.subarray(lo, hi)).sort((a, b) => a - b)
    const median = local[Math.floor(local.length / 2)]!
    if (v - median < margin) continue
    if (f - last < minGap) {
      // Dentro de la separación mínima nos quedamos con el más fuerte.
      const prevIdx = peaks.length - 1
      if (prevIdx >= 0 && v > novelty[last]!) {
        peaks[prevIdx] = f
        last = f
      }
      continue
    }
    peaks.push(f)
    last = f
  }

  // De ventana a frame: retroceder hasta la ventana donde empieza la subida.
  return peaks.map((f) => {
    let g = f
    while (g > 0 && novelty[g - 1]! > 0.02 && f - g < 4) g--
    return g * hop + hop
  })
}

/** Cruce por cero más cercano a `frame` dentro de ±radius frames (subida o bajada). */
export function nearestZeroCrossing(mono: Float32Array, frame: number, radius = 512): number {
  const at = (i: number) => mono[i] ?? 0
  for (let d = 0; d <= radius; d++) {
    for (const i of [frame - d, frame + d]) {
      if (i <= 0 || i >= mono.length) continue
      const a = at(i - 1)
      const b = at(i)
      if (a === 0 || b === 0 || (a < 0) !== (b < 0)) return i
    }
  }
  return frame
}
