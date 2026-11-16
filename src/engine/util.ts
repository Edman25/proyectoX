/** Utilidades numéricas del motor. Sin estado, sin Web Audio. */

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

export function semitonesToRate(semitones: number): number {
  return Math.pow(2, semitones / 12)
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Módulo que siempre devuelve [0, m), también para negativos. */
export function posMod(value: number, m: number): number {
  return ((value % m) + m) % m
}

/**
 * Curva de velocity → ganancia. Cuadrática: 127 = 0 dB, 64 ≈ -12 dB.
 * Es el único lugar donde se decide la curva.
 */
export function velocityToGain(velocity: number): number {
  const x = clamp(velocity, 1, 127) / 127
  return x * x
}
