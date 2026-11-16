/**
 * Clips de audio del arreglo (pistas de audio, modo canción).
 *
 * Warp:
 *  - `off`: el audio suena tal cual; `semitones` actúa como varispeed
 *    (cambia tono y duración, como una cinta).
 *  - `resample`: velocidad = BPM del proyecto / sourceBpm. El tono lo
 *    determina el tempo, así que `semitones` y el pitch del slice no se
 *    aplican (romperían la sincronía). Si no se conoce el BPM de origen
 *    (ni en el clip ni en el asset) se comporta como `off`.
 *  - `preserve`: busca en la caché de renders el audio ya estirado
 *    (ratio = BPM proyecto / sourceBpm, semitonos del clip). FALLBACK: si no
 *    hay render se pide a la caché y el clip suena como `resample`: a
 *    tiempo, con el tono corrido.
 *
 * `offsetTicks` es posición musical dentro del audio: con warp sincronizado
 * se mide al BPM de origen; con `off`, al BPM del proyecto al arrancar.
 */
import { ticksToSeconds, type AudioClip, type ClipId, type Project } from '../model'
import type { RenderCache } from './renderCache'
import { effectiveFades, makeRegion, resolveSampleRef } from './sample'
import type { BufferProvider, PlayableRegion, ReverseCache } from './sample'
import { dbToGain, semitonesToRate } from './util'
import { CUT_FADE_SEC, Voice } from './voice'

interface ActiveClip {
  clip: AudioClip
  voice: Voice
  /** BPM de origen si la velocidad sigue al tempo del proyecto. */
  syncBpm: number | null
}

export interface AudioClipDeps {
  ctx: BaseAudioContext
  buffers: BufferProvider
  renders: RenderCache
  reverse: ReverseCache
}

export class AudioClipPlayer {
  private readonly deps: AudioClipDeps
  private readonly active = new Map<ClipId, ActiveClip>()

  constructor(deps: AudioClipDeps) {
    this.deps = deps
  }

  /** El clip que está sonando con ese id, tal como se programó. */
  playing(clipId: ClipId): AudioClip | undefined {
    return this.active.get(clipId)?.clip
  }

  playingIds(): ClipId[] {
    return [...this.active.keys()]
  }

  /**
   * Arranca el clip en `time`, `intoTicks` después de su inicio (0 si
   * empieza desde el principio; > 0 al entrar a media canción).
   */
  start(
    clip: AudioClip,
    output: AudioNode,
    project: Project,
    time: number,
    intoTicks: number,
  ): void {
    const { ctx, buffers, renders, reverse } = this.deps
    this.stop(clip.id, time)
    const resolved = resolveSampleRef(project.assets, clip.sample)
    if (!resolved) return
    const { playback } = resolved
    const bpm = project.bpm
    const when = Math.max(time, ctx.currentTime)
    const posTicks = clip.offsetTicks + intoTicks
    const sourceBpm = clip.warp.sourceBpm ?? project.assets[resolved.assetId]?.bpm ?? null
    const synced = clip.warp.mode !== 'off' && sourceBpm !== null && sourceBpm > 0

    let region: PlayableRegion | null = null
    let rate = semitonesToRate(clip.warp.semitones + playback.pitch)
    let offsetSec = ticksToSeconds(posTicks, bpm) * rate
    let syncBpm: number | null = null

    if (synced && clip.warp.mode === 'preserve') {
      const key = {
        assetId: resolved.assetId,
        start: resolved.start,
        end: resolved.end,
        stretchRatio: bpm / sourceBpm,
        semitones: clip.warp.semitones,
        mode: 'preserve' as const,
      }
      const rendered = renders.get(key)
      if (rendered) {
        // El render ya está al tempo del proyecto: velocidad 1, sin seguir el BPM.
        region = makeRegion(ctx, reverse, rendered, 0, rendered.length, playback.reverse)
        rate = 1
        offsetSec = ticksToSeconds(posTicks, bpm)
      } else {
        renders.request?.(key)
      }
    }
    if (!region) {
      const buffer = buffers.getBuffer(resolved.assetId)
      if (!buffer) return
      region = makeRegion(ctx, reverse, buffer, resolved.start, resolved.end, playback.reverse)
      if (synced) {
        rate = bpm / sourceBpm
        offsetSec = ticksToSeconds(posTicks, sourceBpm)
        syncBpm = sourceBpm
      }
    }
    if (!region) return
    if (offsetSec >= (region.endFrame - region.startFrame) / region.buffer.sampleRate) return

    const fades = effectiveFades(region, playback)
    const voice = new Voice(ctx, output, {
      region,
      when,
      gain: dbToGain(clip.gainDb + playback.gainDb),
      playbackRate: rate,
      // Entrar a medio clip es un corte: micro-fade para que no haga click.
      fadeInSec: intoTicks > 0 ? Math.max(fades.fadeInSec, CUT_FADE_SEC) : fades.fadeInSec,
      // Con velocidad ligada al tempo el final natural puede moverse: sin fade programado.
      fadeOutSec: syncBpm === null ? fades.fadeOutSec : 0,
      offsetSec,
    })
    this.active.set(clip.id, { clip, voice, syncBpm })
  }

  stop(clipId: ClipId, time: number): void {
    const entry = this.active.get(clipId)
    if (!entry) return
    this.active.delete(clipId)
    if (entry.voice.startTime > time) entry.voice.cancel()
    else entry.voice.release(time, CUT_FADE_SEC)
  }

  stopAll(time: number): void {
    for (const id of this.playingIds()) this.stop(id, time)
  }

  /** Cambio de BPM: los clips sincronizados por resample siguen al tempo. */
  setTempo(time: number, bpm: number): void {
    for (const entry of this.active.values()) {
      if (entry.syncBpm !== null) entry.voice.setRate(time, bpm / entry.syncBpm)
    }
  }
}
