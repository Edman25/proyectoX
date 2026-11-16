/**
 * Sampler cromático.
 *
 * Modo `resample`: el tono se cambia con la velocidad de reproducción
 * (2^(semitonos/12) respecto a rootNote), en tiempo real.
 *
 * Modo `preserve`: se busca en la caché de renders un buffer ya
 * transpuesto para ese semitono y se toca a velocidad 1. FALLBACK: si no
 * hay render, se pide a la caché (`request`) y la nota suena en modo
 * resample — a tiempo y afinada, aunque cambie de duración. Nunca se queda
 * en silencio ni hace pitch-shift en tiempo real.
 *
 * Voces:
 *  - poly: hasta `maxVoices`; al pasarse se roba la más antigua. Repetir una
 *    altura que sigue sonando la re-dispara.
 *  - mono con glide > 0: legato. Una nota nueva mientras otra suena desliza
 *    el tono sin re-disparar; al soltarla vuelve a la anterior que siga
 *    pulsada.
 *  - mono con glide = 0: cada nota re-dispara y corta a la anterior.
 *  - sustain: los note-off se guardan hasta que se suelta el pedal.
 */
import type { InstrumentEvent, SamplerTrack, Track } from '../../model'
import { effectiveFades, makeRegion, resolveSampleRef, type PlayableRegion } from '../sample'
import { clamp, dbToGain, semitonesToRate, velocityToGain } from '../util'
import { CUT_FADE_SEC, Voice } from '../voice'
import { VoiceList, type Instrument, type InstrumentDeps } from './instrument'

interface HeldNote {
  pitch: number
  velocity: number
}

export class SamplerInstrument implements Instrument {
  private readonly deps: InstrumentDeps
  private track: SamplerTrack
  private readonly list = new VoiceList()
  /** Voces cuya tecla se soltó con el pedal puesto. */
  private readonly sustained = new Set<Voice>()
  private sustainOn = false
  /** Teclas pulsadas en modo mono, en orden. */
  private monoHeld: HeldNote[] = []
  private monoVoice: Voice | null = null

  constructor(deps: InstrumentDeps, track: SamplerTrack) {
    this.deps = deps
    this.track = track
  }

  setTrack(track: Track): void {
    if (track.kind === 'sampler') this.track = track
  }

  handle(event: InstrumentEvent): void {
    const time = Math.max(event.time, this.deps.ctx.currentTime)
    if (event.type === 'sustain') {
      this.sustainOn = event.on
      if (!event.on) {
        for (const v of this.sustained) v.release(time, this.releaseSec())
        this.sustained.clear()
      }
      return
    }
    this.list.prune(time)
    const mono = this.track.voiceMode === 'mono'
    if (event.type === 'noteOn') {
      if (mono) this.monoNoteOn(time, event.target.pitch, event.velocity)
      else this.polyNoteOn(time, event.target.pitch, event.velocity)
    } else if (mono) {
      this.monoNoteOff(time, event.target.pitch)
    } else {
      for (const v of this.list.voices) {
        if (v.key === event.target.pitch && v.gate && v.startTime <= time) this.keyUp(v, time)
      }
    }
  }

  cancelFuture(time: number): void {
    this.list.cancelFuture(time)
  }

  panic(time: number): void {
    this.list.panic(time)
    this.sustained.clear()
    this.monoHeld = []
    this.monoVoice = null
    this.sustainOn = false
  }

  // --- poly ---------------------------------------------------------------

  private polyNoteOn(time: number, pitch: number, velocity: number): void {
    for (const v of this.list.voices) {
      if (v.key === pitch && !v.released && v.startTime <= time) {
        v.release(time, CUT_FADE_SEC)
        this.sustained.delete(v)
      }
    }
    const voice = this.startVoice(time, pitch, velocity)
    if (voice) this.list.add(voice, time, Math.max(1, this.track.maxVoices))
  }

  // --- mono ---------------------------------------------------------------

  private monoNoteOn(time: number, pitch: number, velocity: number): void {
    this.monoHeld = this.monoHeld.filter((h) => h.pitch !== pitch)
    this.monoHeld.push({ pitch, velocity })
    const current = this.activeMonoVoice(time)
    const glideSec = this.track.glideMs / 1000
    if (current && glideSec > 0) {
      this.sustained.delete(current)
      current.gate = true
      this.glideTo(current, time, pitch, glideSec)
      return
    }
    if (current) {
      current.release(time, CUT_FADE_SEC)
      this.sustained.delete(current)
    }
    this.monoVoice = this.startVoice(time, pitch, velocity)
    if (this.monoVoice) this.list.add(this.monoVoice, time, 1)
  }

  private monoNoteOff(time: number, pitch: number): void {
    const wasTop = this.monoHeld.at(-1)?.pitch === pitch
    this.monoHeld = this.monoHeld.filter((h) => h.pitch !== pitch)
    const current = this.activeMonoVoice(time)
    if (!current || !wasTop) return
    const previous = this.monoHeld.at(-1)
    if (!previous) {
      this.keyUp(current, time)
      return
    }
    const glideSec = this.track.glideMs / 1000
    if (glideSec > 0) {
      this.glideTo(current, time, previous.pitch, glideSec)
    } else {
      current.release(time, CUT_FADE_SEC)
      this.monoVoice = this.startVoice(time, previous.pitch, previous.velocity)
      if (this.monoVoice) this.list.add(this.monoVoice, time, 1)
    }
  }

  private activeMonoVoice(time: number): Voice | null {
    const v = this.monoVoice
    return v && !v.released && v.aliveAt(time) ? v : null
  }

  private glideTo(voice: Voice, time: number, pitch: number, glideSec: number): void {
    voice.key = pitch
    voice.setRate(time, this.rateFor(pitch), glideSec)
  }

  // --- común --------------------------------------------------------------

  /** Se soltó la tecla: release, o esperar al pedal. */
  private keyUp(voice: Voice, time: number): void {
    voice.gate = false
    if (this.sustainOn) this.sustained.add(voice)
    else voice.release(time, this.releaseSec())
  }

  private releaseSec(): number {
    return Math.max(1, this.track.envelope.releaseMs) / 1000
  }

  private rateFor(pitch: number): number {
    return semitonesToRate(pitch - this.track.rootNote + this.track.playback.pitch)
  }

  private startVoice(time: number, pitch: number, velocity: number): Voice | null {
    const { ctx, buffers, renders, reverse } = this.deps
    const track = this.track
    const resolved = resolveSampleRef(this.deps.getAssets(), track.sample, track.playback)
    if (!resolved) return null
    const { playback } = resolved
    const semitones = pitch - track.rootNote + playback.pitch
    const sourceFrames = resolved.end - resolved.start

    let region: PlayableRegion | null = null
    let rate = semitonesToRate(semitones)
    if (track.pitchMode === 'preserve' && semitones !== 0) {
      const key = {
        assetId: resolved.assetId,
        start: resolved.start,
        end: resolved.end,
        stretchRatio: 1,
        semitones,
        mode: 'preserve' as const,
      }
      const rendered = renders.get(key)
      if (rendered) {
        // El render es la porción completa, ya transpuesta.
        region = makeRegion(ctx, reverse, rendered, 0, rendered.length, playback.reverse)
        if (region) {
          region.startIsCut = resolved.start > 0
          region.endIsCut = true
          rate = 1
        }
      } else {
        renders.request?.(key)
      }
    }
    if (!region) {
      const buffer = buffers.getBuffer(resolved.assetId)
      if (!buffer) return null
      region = makeRegion(ctx, reverse, buffer, resolved.start, resolved.end, playback.reverse)
    }
    if (!region) return null

    const regionFrames = region.endFrame - region.startFrame
    // Los puntos de loop están en frames de la porción original: se escalan
    // si el buffer que suena (render) tiene otro largo o sample rate.
    const scale = regionFrames / sourceFrames
    let loop: { startFrame: number; endFrame: number } | undefined
    if (track.loop.enabled && track.loop.end > track.loop.start) {
      const a = clamp(Math.round(track.loop.start * scale), 0, regionFrames - 1)
      const b = clamp(Math.round(track.loop.end * scale), a + 1, regionFrames)
      loop = playback.reverse
        ? { startFrame: region.endFrame - b, endFrame: region.endFrame - a }
        : { startFrame: region.startFrame + a, endFrame: region.startFrame + b }
    }

    const fades = effectiveFades(region, playback)
    const env = track.envelope
    const voice = new Voice(ctx, this.deps.output, {
      region,
      when: time,
      gain: velocityToGain(velocity) * dbToGain(playback.gainDb),
      playbackRate: rate,
      fadeInSec: 0,
      fadeOutSec: fades.fadeOutSec,
      envelope: {
        attackSec: Math.max(env.attackMs / 1000, fades.fadeInSec),
        decaySec: env.decayMs / 1000,
        sustain: clamp(env.sustain, 0, 1),
      },
      ...(loop ? { loop } : {}),
    })
    voice.key = pitch
    voice.gate = true
    return voice
  }
}
