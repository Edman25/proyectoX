/**
 * Tiempo musical. Todo lo que vive en el proyecto se mide en ticks; los
 * segundos solo existen en el motor de audio. Esta es la única conversión.
 */

/** Ticks por negra. 960 da ~0.5 ms de resolución a 120 BPM: suficiente para guardar el timing real de una grabación. */
export const PPQ = 960

export type Ticks = number

export interface TimeSignature {
  /** Tiempos por compás (p. ej. 4 en 4/4). */
  numerator: number
  /** Figura que vale un tiempo (4 = negra, 8 = corchea). */
  denominator: number
}

export const MIN_BPM = 20
export const MAX_BPM = 300

export function secondsPerTick(bpm: number): number {
  return 60 / (bpm * PPQ)
}

export function ticksToSeconds(ticks: Ticks, bpm: number): number {
  return ticks * secondsPerTick(bpm)
}

/** Devuelve ticks fraccionarios; redondear es decisión de quien llama. */
export function secondsToTicks(seconds: number, bpm: number): Ticks {
  return seconds / secondsPerTick(bpm)
}

export function ticksPerBeat(ts: TimeSignature): Ticks {
  return (PPQ * 4) / ts.denominator
}

export function ticksPerBar(ts: TimeSignature): Ticks {
  return ticksPerBeat(ts) * ts.numerator
}

/**
 * Ticks de una subdivisión de nota expresada como fracción de redonda.
 * gridTicks(16) = semicorchea, gridTicks(8, true) = corchea de tresillo.
 */
export function gridTicks(division: number, triplet = false): Ticks {
  const base = (PPQ * 4) / division
  return triplet ? (base * 2) / 3 : base
}
