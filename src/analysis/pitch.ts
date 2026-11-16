/**
 * Nota raíz de un sample: McLeod Pitch Method (NSDF) por ventanas, y de las
 * ventanas con tono claro se toma la mediana. Función pura.
 */

export interface RootNote {
  /** Nota MIDI más cercana (69 = A4 = 440 Hz). */
  midi: number
  /** Desviación respecto a esa nota, en cents (−50 a 50). */
  cents: number
  /** 0–1: qué tan claro y estable es el tono. */
  confidence: number
}

const MIN_HZ = 27.5
const MAX_HZ = 2100
/** Ventanas analizadas como máximo, repartidas por toda la señal. */
const MAX_FRAMES = 16
/** Claridad mínima (pico de la NSDF) para contar una ventana. */
const MIN_CLARITY = 0.6
/** Se elige el primer pico que llegue a esta fracción del mayor. */
const PEAK_FRACTION = 0.9

/** Frecuencia y claridad de una ventana, o null si no hay periodicidad. */
function framePitch(
  mono: Float32Array,
  start: number,
  size: number,
  sampleRate: number,
): { hz: number; clarity: number } | null {
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ))
  const maxLag = Math.min(Math.floor(size / 2), Math.ceil(sampleRate / MIN_HZ))
  if (maxLag <= minLag + 2) return null

  // Sumas acumuladas de cuadrados: el denominador de la NSDF sale en O(1).
  const squares = new Float64Array(size + 1)
  for (let i = 0; i < size; i++) {
    const v = mono[start + i] as number
    squares[i + 1] = (squares[i] as number) + v * v
  }
  const total = squares[size] as number
  if (total <= 0) return null

  const nsdf = new Float64Array(maxLag + 1)
  for (let lag = 0; lag <= maxLag; lag++) {
    let acf = 0
    const n = size - lag
    for (let j = 0; j < n; j++) acf += (mono[start + j] as number) * (mono[start + j + lag] as number)
    const energy = (squares[n] as number) + total - (squares[lag] as number)
    nsdf[lag] = energy > 0 ? (2 * acf) / energy : 0
  }

  // Máximo de cada lóbulo positivo, después de la primera bajada a negativo.
  const peaks: number[] = []
  let lag = 1
  while (lag <= maxLag && (nsdf[lag] as number) > 0) lag++
  let best = -1
  for (; lag < maxLag; lag++) {
    const v = nsdf[lag] as number
    if (v > 0) {
      const isPeak = v >= (nsdf[lag - 1] as number) && v > (nsdf[lag + 1] as number)
      if (isPeak && (best < 0 || v > (nsdf[best] as number))) best = lag
    } else if (best >= 0) {
      peaks.push(best)
      best = -1
    }
  }
  if (best >= 0) peaks.push(best)

  let highest = 0
  for (const p of peaks) if (p >= minLag) highest = Math.max(highest, nsdf[p] as number)
  if (highest <= 0) return null
  const chosen = peaks.find((p) => p >= minLag && (nsdf[p] as number) >= highest * PEAK_FRACTION)
  if (chosen === undefined) return null

  // Interpolación parabólica alrededor del pico.
  const a = nsdf[chosen - 1] as number
  const b = nsdf[chosen] as number
  const c = nsdf[chosen + 1] as number
  const denom = a - 2 * b + c
  const shift = denom < 0 ? (0.5 * (a - c)) / denom : 0
  const period = chosen + Math.max(-0.5, Math.min(0.5, shift))
  const clarity = Math.min(1, b - 0.25 * (a - c) * shift)
  return { hz: sampleRate / period, clarity }
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/**
 * Nota raíz de `mono`. Analiza la parte sostenida (las ventanas con nivel
 * y tono claro; el ataque se descarta si hay con qué). null si no hay un
 * tono reconocible (silencio, ruido, percusión).
 */
export function detectRootNote(mono: Float32Array, sampleRate: number): RootNote | null {
  if (!(sampleRate > 0)) return null
  const size = Math.min(mono.length, Math.round(sampleRate * 0.085))
  if (size < Math.ceil((sampleRate / MAX_HZ) * 8)) return null
  const span = mono.length - size
  const hop = Math.max(size >> 1, Math.ceil(span / (MAX_FRAMES - 1)))

  const starts: number[] = []
  const levels: number[] = []
  let loudest = 0
  for (let start = 0; start <= span; start += hop) {
    let sum = 0
    for (let i = 0; i < size; i++) sum += (mono[start + i] as number) ** 2
    const rms = Math.sqrt(sum / size)
    starts.push(start)
    levels.push(rms)
    loudest = Math.max(loudest, rms)
  }
  if (loudest < 1e-5) return null

  const found: { note: number; clarity: number }[] = []
  let loud = 0
  starts.forEach((start, i) => {
    if ((levels[i] as number) < loudest * 0.2) return
    loud++
    const pitch = framePitch(mono, start, size, sampleRate)
    if (!pitch || pitch.clarity < MIN_CLARITY) return
    found.push({ note: 69 + 12 * Math.log2(pitch.hz / 440), clarity: pitch.clarity })
  })
  if (found.length === 0) return null
  // La primera ventana con tono suele incluir el ataque.
  const stable = found.length >= 4 ? found.slice(1) : found

  const center = median(stable.map((f) => f.note))
  const agreeing = stable.filter((f) => Math.abs(f.note - center) <= 0.5)
  let weight = 0
  let noteSum = 0
  let claritySum = 0
  for (const f of agreeing) {
    weight += f.clarity
    noteSum += f.note * f.clarity
    claritySum += f.clarity
  }
  if (weight <= 0) return null
  const note = noteSum / weight
  const midi = Math.round(note)
  const voiced = (agreeing.length + (found.length - stable.length)) / loud
  return {
    midi,
    cents: (note - midi) * 100,
    confidence: Math.max(0, Math.min(1, (claritySum / agreeing.length) * voiced)),
  }
}
