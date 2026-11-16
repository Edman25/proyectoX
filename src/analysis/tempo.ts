/**
 * Tempo de un loop: envolvente de ataques → autocorrelación → el tempo
 * cuyo pulso (y sus múltiplos) mejor encaja. Función pura.
 */

export interface BpmEstimate {
  bpm: number
  /** 0–1: qué tan periódico es el pulso encontrado. */
  confidence: number
}

export interface BpmOptions {
  minBpm?: number
  maxBpm?: number
  /**
   * Si el tempo hallado hace que el audio dure casi un número entero de
   * compases de 4/4, se ajusta para que dure exactamente eso (un loop bien
   * recortado da así su tempo exacto). Por defecto, sí.
   */
  snapToLoop?: boolean
}

/** Cuadros de la envolvente por segundo. */
const ENVELOPE_RATE = 200
/** Como mucho se analiza este tramo inicial. */
const MAX_SECONDS = 60
/** Centro y ancho (en octavas) de la preferencia entre doble y mitad. */
const PREFERRED_BPM = 120
const PREFERENCE_OCTAVES = 0.8
/** Tolerancia del ajuste a compases enteros. */
const SNAP_TOLERANCE = 0.015

/**
 * Fuerza de ataque por cuadro: subidas de la energía (en log), sumando la
 * señal tal cual y su derivada (que resalta platos y agudos).
 */
function onsetEnvelope(mono: Float32Array, sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate / ENVELOPE_RATE))
  const frames = Math.floor(Math.min(mono.length, MAX_SECONDS * sampleRate) / hop)
  const envelope = new Float32Array(Math.max(0, frames))
  let peak = 0
  for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i] as number))
  if (peak <= 0) return envelope
  const scale = 1000 / (peak * peak)
  let previousLow = 0
  let previousHigh = 0
  let last = 0
  for (let f = 0; f < frames; f++) {
    let low = 0
    let high = 0
    const from = f * hop
    for (let i = from; i < from + hop; i++) {
      const v = mono[i] as number
      const d = v - last
      low += v * v
      high += d * d
      last = v
    }
    const logLow = Math.log1p((low / hop) * scale)
    const logHigh = Math.log1p((high / hop) * scale)
    if (f > 0) envelope[f] = Math.max(0, logLow - previousLow) + Math.max(0, logHigh - previousHigh)
    previousLow = logLow
    previousHigh = logHigh
  }
  return envelope
}

/** Autocorrelación sin sesgo y normalizada (1 en el desfase 0) de la envolvente sin su media. */
function autocorrelation(envelope: Float32Array, maxLag: number): Float64Array {
  const n = envelope.length
  let mean = 0
  for (let i = 0; i < n; i++) mean += envelope[i] as number
  mean /= n || 1
  const acf = new Float64Array(maxLag + 1)
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i + lag < n; i++) sum += ((envelope[i] as number) - mean) * ((envelope[i + lag] as number) - mean)
    acf[lag] = sum / (n - lag)
  }
  const zero = acf[0] as number
  if (zero > 0) for (let lag = 0; lag <= maxLag; lag++) acf[lag] = (acf[lag] as number) / zero
  return acf
}

/**
 * Tempo de `mono` entre `minBpm` y `maxBpm` (60–180 por defecto).
 *
 * Doble o mitad: gana el tempo cuyo pulso explica mejor los ataques; a
 * igualdad de evidencia (lo normal entre un tempo y su mitad) se prefiere
 * el más cercano a 120. En la práctica: por encima de ~165 se devuelve la
 * mitad, y un loop lento con corcheas marcadas puede salir al doble. La UI
 * debería ofrecer ×2 / ÷2.
 *
 * Sin pulso reconocible devuelve confianza 0 (y 120 como valor neutro).
 */
export function estimateBpm(mono: Float32Array, sampleRate: number, options: BpmOptions = {}): BpmEstimate {
  const minBpm = options.minBpm ?? 60
  const maxBpm = options.maxBpm ?? 180
  const none: BpmEstimate = { bpm: 120, confidence: 0 }
  if (!(sampleRate > 0) || mono.length === 0) return none

  const hop = Math.max(1, Math.round(sampleRate / ENVELOPE_RATE))
  const rate = sampleRate / hop
  const envelope = onsetEnvelope(mono, sampleRate)
  // Hace falta ver al menos dos pulsos del tempo más lento... o lo que haya.
  const maxLag = Math.min(Math.floor(envelope.length * 0.6), Math.ceil((4 * 60 * rate) / minBpm))
  if (maxLag < 4) return none
  const acf = autocorrelation(envelope, maxLag)
  if (!((acf[0] as number) > 0)) return none

  const at = (lag: number): number => {
    const i = Math.floor(lag)
    const t = lag - i
    return (acf[i] as number) * (1 - t) + (acf[Math.min(maxLag, i + 1)] as number) * t
  }

  let bestBpm = 0
  let bestScore = -Infinity
  let bestEvidence = 0
  for (let bpm = minBpm; bpm <= maxBpm + 1e-9; bpm += 0.05) {
    const beat = (60 * rate) / bpm
    const multiples = Math.min(4, Math.floor(maxLag / beat))
    if (multiples < 1) continue
    let evidence = 0
    for (let k = 1; k <= multiples; k++) evidence += at(k * beat)
    evidence /= multiples
    const octaves = Math.log2(bpm / PREFERRED_BPM) / PREFERENCE_OCTAVES
    const score = evidence * Math.exp(-0.5 * octaves * octaves)
    if (score > bestScore) {
      bestScore = score
      bestBpm = bpm
      bestEvidence = evidence
    }
  }
  if (bestBpm === 0 || bestEvidence <= 0) return none

  let bpm = bestBpm
  if (options.snapToLoop ?? true) {
    const beats = (mono.length / sampleRate) * (bpm / 60)
    const whole = Math.round(beats / 4) * 4
    if (whole >= 4 && Math.abs(beats - whole) / beats < SNAP_TOLERANCE) {
      const snapped = (whole * 60) / (mono.length / sampleRate)
      if (snapped >= minBpm && snapped <= maxBpm) bpm = snapped
    }
  }
  return { bpm: Math.round(bpm * 100) / 100, confidence: Math.max(0, Math.min(1, bestEvidence)) }
}
