/**
 * Del patrón a golpes en el tiempo. Funciones puras: el scheduler pregunta
 * "¿qué notas empiezan en la ventana [from, to)?" y aquí se resuelven el
 * loop del patrón, el swing y los recortes del clip.
 *
 * Garantía que sostienen los tests: si las ventanas son contiguas
 * ([a,b), [b,c), …), cada repetición de cada nota sale exactamente una vez.
 */
import type { Pattern } from '../model'
import { applySwing } from './swing'

export interface SequencedNote {
  /** Tick (del transporte) donde empieza. Fraccionario si hay swing. */
  onTick: number
  /** Tick donde termina. Siempre > onTick. */
  offTick: number
  pitch: number
  velocity: number
}

/**
 * Notas del patrón que empiezan en [from, to).
 *
 * El patrón se repite cada `lengthTicks` a partir de `origin`. Con
 * `clipStart`/`clipEnd` solo suenan las que empiezan dentro del clip, y
 * ninguna dura más allá de su final.
 *
 * Reglas:
 *  - una nota puede durar más allá del final del patrón (se graba así
 *    cuando sueltas después de dar la vuelta): su final cae en la siguiente
 *    repetición;
 *  - nunca dura más que el patrón, para que no se pise con su propia
 *    siguiente repetición;
 *  - las notas con `tick` fuera de [0, lengthTicks) no suenan (quedaron
 *    fuera al acortar el patrón; no se borran).
 */
export function collectNotes(
  pattern: Pattern,
  origin: number,
  from: number,
  to: number,
  clipStart = -Infinity,
  clipEnd = Infinity,
): SequencedNote[] {
  const len = pattern.lengthTicks
  const lo = Math.max(from, clipStart)
  const hi = Math.min(to, clipEnd)
  if (!(len > 0) || pattern.notes.length === 0 || lo >= hi) return []

  const { swing, swingGridTicks: grid } = pattern
  const out: SequencedNote[] = []
  // El swing puede empujar un golpe un poco más allá del final de su
  // repetición (si el largo no es múltiplo del par de la rejilla): por eso
  // se mira también la repetición anterior.
  const kMin = Math.max(0, Math.floor((lo - origin) / len) - 1)
  const kMax = Math.floor((hi - origin) / len)
  for (let k = kMin; k <= kMax; k++) {
    const base = origin + k * len
    for (const note of pattern.notes) {
      if (note.tick < 0 || note.tick >= len) continue
      const onTick = base + applySwing(note.tick, swing, grid)
      if (onTick < lo || onTick >= hi) continue
      const duration = Math.min(Math.max(1, note.durationTicks), len)
      const swungEnd = base + applySwing(note.tick + duration, swing, grid)
      const offTick = Math.min(Math.max(swungEnd, onTick + 1), onTick + len, clipEnd)
      out.push({ onTick, offTick, pitch: note.pitch, velocity: note.velocity })
    }
  }
  return out.sort((a, b) => a.onTick - b.onTick)
}
