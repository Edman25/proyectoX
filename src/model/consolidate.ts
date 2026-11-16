/**
 * Consolidar: une porciones de audio (slices de uno o varios samples, en
 * cualquier orden) en un audio nuevo. Es lo que hace la tira de chops y el
 * "unir slices no contiguos". Función pura sobre canales PCM.
 *
 * Se aplican la ganancia, la reversa y los fades de cada porción; el tono
 * no (cambiarlo cambiaría la duración y descuadraría el loop). Cada unión
 * lleva un micro-fade para que no haya clicks.
 */
import { EDGE_FADE_MS } from './defaults'
import type { PlaybackOptions } from './project'

export interface Segment {
  /** Canales del audio de origen (todos del mismo largo). */
  channels: readonly Float32Array[]
  start: number
  end: number
  playback: PlaybackOptions
}

export interface Consolidated {
  channels: Float32Array[]
  /** Frame donde empieza cada porción en el audio nuevo (para cortarlo igual). */
  boundaries: number[]
}

export function consolidate(segments: readonly Segment[], sampleRate: number): Consolidated {
  const outChannels = Math.max(1, ...segments.map((s) => s.channels.length))
  const total = segments.reduce((n, s) => n + Math.max(0, s.end - s.start), 0)
  const channels = Array.from({ length: outChannels }, () => new Float32Array(total))
  const boundaries: number[] = []
  let at = 0
  for (const seg of segments) {
    const len = Math.max(0, seg.end - seg.start)
    if (len === 0) continue
    boundaries.push(at)
    const gain = Math.pow(10, seg.playback.gainDb / 20)
    const fadeIn = Math.min(len / 2, Math.round((Math.max(EDGE_FADE_MS, seg.playback.fadeInMs) / 1000) * sampleRate))
    const fadeOut = Math.min(len / 2, Math.round((Math.max(EDGE_FADE_MS, seg.playback.fadeOutMs) / 1000) * sampleRate))
    for (let c = 0; c < outChannels; c++) {
      // Mono → se copia a todos los canales; si faltan canales, se usa el último.
      const src = seg.channels[Math.min(c, seg.channels.length - 1)]
      if (!src) continue
      const out = channels[c]!
      for (let i = 0; i < len; i++) {
        const srcIndex = seg.playback.reverse ? seg.end - 1 - i : seg.start + i
        let g = gain
        if (i < fadeIn) g *= i / fadeIn
        if (i >= len - fadeOut) g *= (len - 1 - i) / fadeOut
        out[at + i] = (src[srcIndex] ?? 0) * g
      }
    }
    at += len
  }
  return { channels, boundaries }
}
