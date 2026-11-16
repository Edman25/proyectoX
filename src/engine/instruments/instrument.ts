/**
 * Contrato común de los instrumentos. Reciben InstrumentEvents con
 * timestamp por una sola puerta (`handle`), vengan del secuenciador o de la
 * entrada en vivo. Un evento con `time` en el pasado se toca ya.
 */
import type { AssetId, InstrumentEvent, SampleAsset, Track } from '../../model'
import type { RenderCache } from '../renderCache'
import type { BufferProvider, ReverseCache } from '../sample'
import { CUT_FADE_SEC, type Voice } from '../voice'

export interface InstrumentDeps {
  ctx: BaseAudioContext
  /** Entrada del canal de mixer de la pista. */
  output: AudioNode
  buffers: BufferProvider
  renders: RenderCache
  reverse: ReverseCache
  /** Biblioteca del proyecto vigente (se lee en cada nota). */
  getAssets(): Readonly<Record<AssetId, SampleAsset>>
}

export interface Instrument {
  /** Nueva versión de la pista. Las voces que ya suenan no cambian. */
  setTrack(track: Track): void
  handle(event: InstrumentEvent): void
  /** Quita las voces programadas que aún no empiezan en `time` (al parar). */
  cancelFuture(time: number): void
  /** Silencia todo ya. */
  panic(time: number): void
}

/** Tope de voces simultáneas para Drum Rack y Slicer. */
export const MAX_ONE_SHOT_VOICES = 32

/** Lista de voces con la contabilidad por tiempo que comparten los instrumentos. */
export class VoiceList {
  voices: Voice[] = []

  /** Olvida las que ya terminaron en `time`. */
  prune(time: number): void {
    if (this.voices.some((v) => !v.aliveAt(time))) {
      this.voices = this.voices.filter((v) => v.aliveAt(time))
    }
  }

  add(voice: Voice, time: number, maxVoices: number): void {
    this.voices.push(voice)
    // Robo de voz: se va la más antigua que aún no esté en release.
    let excess = this.voices.filter((v) => !v.released).length - maxVoices
    for (const v of this.voices) {
      if (excess <= 0) break
      if (v.released || v === voice) continue
      v.release(time, CUT_FADE_SEC)
      excess--
    }
  }

  cancelFuture(time: number): void {
    for (const v of this.voices) if (v.startTime > time) v.cancel()
    this.prune(time)
  }

  panic(time: number): void {
    for (const v of this.voices) {
      if (v.startTime > time) v.cancel()
      else v.release(time, CUT_FADE_SEC)
    }
    this.voices = []
  }
}
