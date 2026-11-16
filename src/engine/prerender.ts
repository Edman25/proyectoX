/**
 * Pre-render de un Sampler en `preserve`: pide a la caché el render de cada
 * semitono alrededor de la nota raíz, para que al tocar ya estén.
 */
import type { Project, TrackId } from '../model'
import type { RenderKey } from './renderCache'
import { resolveSampleRef } from './sample'

/** Lo que se necesita de la caché (LruRenderCache lo cumple). */
export interface PrerenderCache {
  has(key: RenderKey): boolean
  request(key: RenderKey): void
}

export interface PrerenderStatus {
  /** Renders que necesita la pista en el rango. */
  total: number
  /** Los que ya están en la caché. */
  ready: number
}

/**
 * Claves de render del Sampler para ±`range` semitonos desde la raíz, las
 * más cercanas a la raíz primero. Vacío si la pista no es un Sampler en
 * `preserve` o no tiene sample. Son las mismas claves que pide el motor.
 */
export function samplerRenderKeys(project: Project, trackId: TrackId, range = 24): RenderKey[] {
  const track = project.tracks[trackId]
  if (!track || track.kind !== 'sampler' || track.pitchMode !== 'preserve') return []
  const resolved = resolveSampleRef(project.assets, track.sample, track.playback)
  if (!resolved) return []
  const keys: RenderKey[] = []
  for (let distance = 1; distance <= range; distance++) {
    for (const offset of [distance, -distance]) {
      const pitch = track.rootNote + offset
      if (pitch < 0 || pitch > 127) continue
      const semitones = offset + resolved.playback.pitch
      if (semitones === 0) continue
      keys.push({
        assetId: resolved.assetId,
        start: resolved.start,
        end: resolved.end,
        stretchRatio: 1,
        semitones,
        mode: 'preserve',
      })
    }
  }
  return keys
}

/**
 * Pide los renders que falten. Idempotente: lo que ya está o ya está en
 * curso no se repite, así que se puede llamar cada vez que se arma o
 * selecciona la pista. Devuelve cuántos hay listos (para un indicador).
 */
export function prerenderSampler(
  project: Project,
  trackId: TrackId,
  cache: PrerenderCache,
  range = 24,
): PrerenderStatus {
  const keys = samplerRenderKeys(project, trackId, range)
  let ready = 0
  for (const key of keys) {
    if (cache.has(key)) ready++
    else cache.request(key)
  }
  return { total: keys.length, ready }
}
