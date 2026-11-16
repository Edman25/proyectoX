/**
 * De referencias del modelo (SampleRef) a audio reproducible.
 *
 * El motor no carga ni decodifica: pide los AudioBuffer a un BufferProvider
 * que implementa la app (IndexedDB). Si un buffer aún no está, la nota
 * simplemente no suena.
 */
import {
  DEFAULT_PLAYBACK,
  EDGE_FADE_MS,
  type AssetId,
  type PlaybackOptions,
  type SampleAsset,
  type SampleRef,
} from '../model'

export interface BufferProvider {
  /** Debe ser síncrono y barato: se llama en cada nota. */
  getBuffer(assetId: AssetId): AudioBuffer | undefined
}

export interface ResolvedSample {
  assetId: AssetId
  /** Frame inicial (incluido), en frames del asset. */
  start: number
  /** Frame final (excluido). */
  end: number
  playback: PlaybackOptions
}

/**
 * Suma dos capas de ajustes (p. ej. las del slice y las del pad que lo usa):
 * ganancias y tonos se suman, las reversas se cancelan entre sí y de cada
 * fade gana el más largo.
 */
export function combinePlayback(a: PlaybackOptions, b: PlaybackOptions): PlaybackOptions {
  return {
    gainDb: a.gainDb + b.gainDb,
    pitch: a.pitch + b.pitch,
    reverse: a.reverse !== b.reverse,
    fadeInMs: Math.max(a.fadeInMs, b.fadeInMs),
    fadeOutMs: Math.max(a.fadeOutMs, b.fadeOutMs),
  }
}

/**
 * Función pura: resuelve un SampleRef a asset + rango de frames +
 * PlaybackOptions efectivas. `extra` son los ajustes de quien usa la
 * referencia (pad, sampler). Devuelve null si falta el asset o el slice, o
 * si el rango queda vacío.
 */
export function resolveSampleRef(
  assets: Readonly<Record<AssetId, SampleAsset>>,
  ref: SampleRef | null,
  extra: PlaybackOptions = DEFAULT_PLAYBACK,
): ResolvedSample | null {
  if (!ref) return null
  const asset = assets[ref.assetId]
  if (!asset) return null
  let start = 0
  let end = asset.frames
  let own: PlaybackOptions = DEFAULT_PLAYBACK
  if (ref.kind === 'slice') {
    const slice = asset.slices.find((s) => s.id === ref.sliceId)
    if (!slice) return null
    start = slice.start
    end = slice.end
    own = slice.playback
  } else if (ref.kind === 'range') {
    start = ref.start
    end = ref.end
  }
  start = Math.max(0, Math.floor(start))
  end = Math.min(asset.frames, Math.floor(end))
  if (end <= start) return null
  return { assetId: asset.id, start, end, playback: combinePlayback(own, extra) }
}

/** Buffers invertidos, uno por buffer original. Se liberan con el original. */
export class ReverseCache {
  private readonly cache = new WeakMap<AudioBuffer, AudioBuffer>()

  get(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
    let reversed = this.cache.get(buffer)
    if (!reversed) {
      reversed = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = Float32Array.from(buffer.getChannelData(ch)).reverse()
        reversed.copyToChannel(data, ch)
      }
      this.cache.set(buffer, reversed)
    }
    return reversed
  }
}

/** Una porción lista para sonar: ya con la reversa aplicada. */
export interface PlayableRegion {
  buffer: AudioBuffer
  startFrame: number
  endFrame: number
  /** El borde por donde empieza a sonar es un corte dentro del audio. */
  startIsCut: boolean
  /** El borde donde termina de sonar es un corte dentro del audio. */
  endIsCut: boolean
}

/** Rango de `buffer` (en frames suyos) → región reproducible, invertida si toca. */
export function makeRegion(
  ctx: BaseAudioContext,
  reverseCache: ReverseCache,
  buffer: AudioBuffer,
  start: number,
  end: number,
  reverse: boolean,
): PlayableRegion | null {
  const length = buffer.length
  const s = Math.max(0, Math.min(start, length))
  const e = Math.max(0, Math.min(end, length))
  if (e <= s) return null
  if (!reverse) {
    return { buffer, startFrame: s, endFrame: e, startIsCut: s > 0, endIsCut: e < length }
  }
  return {
    buffer: reverseCache.get(ctx, buffer),
    startFrame: length - e,
    endFrame: length - s,
    startIsCut: e < length,
    endIsCut: s > 0,
  }
}

/**
 * Fades efectivos en segundos. Un borde que es un corte dentro del audio
 * lleva como mínimo EDGE_FADE_MS para no hacer click; el principio y el
 * final reales del archivo se respetan tal cual (ahí el ataque es el que
 * trae el sample).
 */
export function effectiveFades(
  region: PlayableRegion,
  playback: PlaybackOptions,
): { fadeInSec: number; fadeOutSec: number } {
  return {
    fadeInSec: Math.max(playback.fadeInMs, region.startIsCut ? EDGE_FADE_MS : 0) / 1000,
    fadeOutSec: Math.max(playback.fadeOutMs, region.endIsCut ? EDGE_FADE_MS : 0) / 1000,
  }
}
