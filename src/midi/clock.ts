/**
 * Del reloj de los eventos (performance.now(), en ms) al reloj de audio
 * (segundos del AudioContext).
 *
 * Convención de todo el sistema: el `time` de un evento en vivo es **el
 * punto del audio que se estaba escuchando cuando ocurrió el gesto**. Así,
 * un golpe dado exactamente sobre el clic del metrónomo recibe el tiempo en
 * que ese clic estaba programado, y el grabador lo coloca en su sitio sin
 * más cuentas. Como ese instante siempre queda un poco atrás de
 * `currentTime`, el motor lo toca "ya".
 */

export interface AudioClock {
  /** Tiempo de audio (s) que corresponde a un instante de performance.now() (ms). */
  toAudioTime(performanceMs: number): number
}

/** Lo que se necesita de un AudioContext en vivo (se puede simular en tests). */
export interface OutputTimestampSource {
  readonly currentTime: number
  readonly outputLatency?: number
  getOutputTimestamp?(): { contextTime?: number; performanceTime?: number }
}

/**
 * Reloj en vivo. Usa `getOutputTimestamp()`, que da un par (tiempo de audio
 * que está saliendo, performance.now()) medido por el navegador. Si no está
 * disponible o aún no reporta nada, cae a `currentTime − outputLatency`.
 */
export function outputTimestampClock(
  context: OutputTimestampSource,
  now: () => number = () => performance.now(),
): AudioClock {
  return {
    toAudioTime(performanceMs) {
      const stamp = context.getOutputTimestamp?.()
      if (stamp && stamp.performanceTime !== undefined && stamp.contextTime !== undefined) {
        if (stamp.performanceTime > 0) {
          return stamp.contextTime + (performanceMs - stamp.performanceTime) / 1000
        }
      }
      const heardNow = context.currentTime - (context.outputLatency ?? 0)
      return heardNow + (performanceMs - now()) / 1000
    },
  }
}

/** Reloj fijo para tests: audio = performanceMs / 1000 + offsetSec. */
export function fixedClock(offsetSec = 0): AudioClock {
  return { toAudioTime: (performanceMs) => performanceMs / 1000 + offsetSec }
}
