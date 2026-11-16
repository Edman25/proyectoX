/**
 * Estado del transporte para la interfaz: si suena y en qué tick va. El tick
 * se lee del motor en cada cuadro solo mientras suena.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { getEngine } from '../audio/engineHost'

function subscribePlaying(fn: () => void): () => void {
  return getEngine().onStateChange(fn)
}

export function usePlaying(): boolean {
  return useSyncExternalStore(subscribePlaying, () => getEngine().isPlaying)
}

/**
 * Valor derivado del tick actual, recalculado en cada cuadro mientras suena.
 * `derive` debería devolver algo que cambie poco (p. ej. el paso) para no
 * redibujar de más. Devuelve null cuando está parado.
 */
export function usePlayhead<T>(derive: (tick: number, countingIn: boolean) => T): T | null {
  const playing = usePlaying()
  const [value, setValue] = useState<T | null>(null)
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const loop = () => {
      const pos = getEngine().getPosition()
      const next = derive(pos.tick, pos.countingIn)
      setValue((prev) => (Object.is(prev, next) ? prev : next))
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [playing, derive])
  return playing ? value : null
}
