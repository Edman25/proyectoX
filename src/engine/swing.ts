import type { Ticks } from '../model'
import { clamp } from './util'

/**
 * Swing estilo MPC como deformación continua del tiempo.
 *
 * La rejilla se agrupa en pares de pasos (2 × grid). El paso "débil" (el
 * segundo de cada par) se retrasa: con swing 0 cae al 50 % del par, con 0.5
 * al 66.7 % (tresillo) y con 1 al 83.3 %. Todo lo que hay entre medias se
 * estira/encoge de forma lineal, así que el orden de las notas nunca cambia
 * y un flam sigue siendo un flam.
 *
 * Devuelve ticks fraccionarios: es tiempo de reproducción, no se guarda.
 */
export function applySwing(tick: Ticks, swing: number, grid: Ticks): number {
  if (!(swing > 0) || !(grid > 0)) return tick
  const pair = grid * 2
  const base = Math.floor(tick / pair) * pair
  const p = tick - base
  const mid = swungOffbeat(swing, grid)
  return base + (p < grid ? (p * mid) / grid : mid + ((p - grid) * (pair - mid)) / grid)
}

/** Posición (dentro del par) del paso débil con swing aplicado. */
export function swungOffbeat(swing: number, grid: Ticks): number {
  return grid + (clamp(swing, 0, 1) * grid * 2) / 3
}

/** Posición con swing del paso k de la rejilla (k entero, puede ser negativo). */
export function swungGridTick(k: number, swing: number, grid: Ticks): number {
  const odd = ((k % 2) + 2) % 2 === 1
  return odd ? (k - 1) * grid + swungOffbeat(swing, grid) : k * grid
}
