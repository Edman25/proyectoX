/**
 * Una voz: un AudioBufferSourceNode con su envolvente. Es la única pieza
 * que toca nodos de Web Audio para reproducir samples; la usan todos los
 * instrumentos, las pistas de audio y el metrónomo.
 *
 * Cadena: source → env (ataque / fade-in / ADSR × ganancia) → kill → salida.
 * `kill` solo baja: lleva el fade del final natural y los cortes (release,
 * choke, robo de voz). Tener las dos ganancias separadas permite cortar en
 * cualquier momento sin pelear con la automatización de la envolvente.
 *
 * Toda la contabilidad es por tiempo (startTime / endTime), no por
 * callbacks: así funciona igual en vivo que en un render offline, donde
 * todo se programa antes de que el reloj avance.
 */
import type { PlayableRegion } from './sample'

/** Corte rápido sin click: choke, robo de voz, retrigger. */
export const CUT_FADE_SEC = 0.005

export interface VoiceEnvelope {
  attackSec: number
  decaySec: number
  /** 0–1 */
  sustain: number
}

export interface VoiceParams {
  region: PlayableRegion
  /** Tiempo de inicio en el reloj del contexto. */
  when: number
  /** Ganancia lineal total (velocity × gainDb …). */
  gain: number
  playbackRate: number
  fadeInSec: number
  /** Fade en el final natural de la región (no aplica con loop). */
  fadeOutSec: number
  /** Si está, sustituye al fade-in. */
  envelope?: VoiceEnvelope
  /** Loop de sostenido, en frames del buffer de la región. */
  loop?: { startFrame: number; endFrame: number }
  /** Empezar más adentro de la región, en segundos de audio fuente. */
  offsetSec?: number
}

export class Voice {
  readonly startTime: number
  /** Cuándo queda en silencio. Infinity si loopea o no se puede saber. */
  endTime: number
  /** Etiquetas libres para el instrumento dueño. */
  key = 0
  group: number | null = null
  gate = false
  /** Release al soltar en modo gate (el fade-out del sample, si tiene). */
  gateReleaseSec = 0
  /** Ya recibió su release (por note-off, choke o robo). */
  released = false

  private readonly ctx: BaseAudioContext
  private readonly source: AudioBufferSourceNode
  private readonly kill: GainNode
  private stopScheduled = false
  // Rampa de bajada vigente en `kill`: valor(t) = relV0 · (1 − (t − relT0) / relDur).
  private relT0: number | null = null
  private relV0 = 1
  private relDur = 0
  // Último cambio de velocidad: de rateFrom a rateTo entre rateT0 y rateT1.
  private rateFrom: number
  private rateTo: number
  private rateT0 = -Infinity
  private rateT1 = -Infinity

  constructor(ctx: BaseAudioContext, output: AudioNode, params: VoiceParams) {
    const { region, when, gain, playbackRate } = params
    const sr = region.buffer.sampleRate
    const offsetSec = Math.max(0, params.offsetSec ?? 0)
    const regionSec = (region.endFrame - region.startFrame) / sr - offsetSec
    const naturalSec = Math.max(0, regionSec) / playbackRate

    this.ctx = ctx
    this.startTime = when
    this.rateFrom = playbackRate
    this.rateTo = playbackRate
    const source = ctx.createBufferSource()
    source.buffer = region.buffer
    source.playbackRate.value = playbackRate
    const env = ctx.createGain()
    const kill = ctx.createGain()
    source.connect(env)
    env.connect(kill)
    kill.connect(output)
    this.source = source
    this.kill = kill

    const startOffset = region.startFrame / sr + offsetSec
    if (params.loop) {
      source.loop = true
      source.loopStart = params.loop.startFrame / sr
      source.loopEnd = params.loop.endFrame / sr
      source.start(when, startOffset)
      this.endTime = Infinity
    } else {
      // `duration` va en segundos de audio fuente (no depende del playbackRate).
      source.start(when, startOffset, Math.max(0, regionSec))
      this.endTime = when + naturalSec
    }

    const limit = params.loop ? Infinity : naturalSec / 2
    const g = env.gain
    if (params.envelope) {
      const attack = Math.max(0.0005, params.envelope.attackSec)
      const decay = Math.max(0.001, params.envelope.decaySec)
      g.setValueAtTime(0, when)
      g.linearRampToValueAtTime(gain, when + attack)
      if (params.envelope.sustain < 1) {
        g.linearRampToValueAtTime(gain * params.envelope.sustain, when + attack + decay)
      }
    } else if (params.fadeInSec > 0) {
      g.setValueAtTime(0, when)
      g.linearRampToValueAtTime(gain, when + Math.min(params.fadeInSec, limit))
    } else {
      g.value = gain
    }

    if (!params.loop && params.fadeOutSec > 0 && naturalSec > 0) {
      const fade = Math.min(params.fadeOutSec, limit)
      this.relT0 = this.endTime - fade
      this.relV0 = 1
      this.relDur = fade
      kill.gain.setValueAtTime(1, this.relT0)
      kill.gain.linearRampToValueAtTime(0, this.endTime)
    }

    source.onended = () => {
      this.endTime = Math.min(this.endTime, this.ctx.currentTime)
      kill.disconnect()
    }
  }

  /** ¿Está sonando (o por sonar) en el instante `time`? */
  aliveAt(time: number): boolean {
    return time < this.endTime
  }

  /**
   * Baja a silencio desde `time` en `fadeSec` y para la fuente. Si la voz ya
   * iba a callarse antes, no hace nada. Se puede llamar varias veces: gana
   * el final más temprano.
   */
  release(time: number, fadeSec: number): void {
    const t = Math.max(time, this.startTime)
    const fade = Math.max(0.0005, fadeSec)
    const end = t + fade
    this.released = true
    if (end >= this.endTime) return
    let value = 1
    if (this.relT0 !== null && t > this.relT0) {
      value = Math.max(0, this.relV0 * (1 - (t - this.relT0) / this.relDur))
    }
    const g = this.kill.gain
    g.cancelScheduledValues(t)
    // Si ya había una bajada en curso, se conserva su tramo hasta `t`.
    if (value < 1) g.linearRampToValueAtTime(value, t)
    else g.setValueAtTime(1, t)
    g.linearRampToValueAtTime(0, end)
    this.relT0 = t
    this.relV0 = value
    this.relDur = fade
    this.endTime = end
    if (!this.stopScheduled) {
      this.stopScheduled = true
      this.source.stop(end + 0.001)
    }
  }

  /**
   * Cambia la velocidad de reproducción (glide, cambio de BPM). El glide es
   * una rampa exponencial: lineal en tono, que es como se oye un portamento.
   */
  setRate(time: number, rate: number, glideSec = 0): void {
    const t = Math.max(time, this.startTime)
    const p = this.source.playbackRate
    const current = this.rateAt(t)
    p.cancelScheduledValues(t)
    p.setValueAtTime(current, t)
    if (glideSec > 0) p.exponentialRampToValueAtTime(rate, t + glideSec)
    else p.setValueAtTime(rate, t)
    this.rateFrom = current
    this.rateTo = rate
    this.rateT0 = t
    this.rateT1 = t + Math.max(0, glideSec)
    // El final natural ya no es calculable; onended o un release lo fijan.
    if (!this.released) this.endTime = Infinity
  }

  /** Velocidad programada en `time` (se lleva la cuenta aquí para no depender de leer el AudioParam). */
  private rateAt(time: number): number {
    if (time >= this.rateT1) return this.rateTo
    if (time <= this.rateT0) return this.rateFrom
    const x = (time - this.rateT0) / (this.rateT1 - this.rateT0)
    return this.rateFrom * Math.pow(this.rateTo / this.rateFrom, x)
  }

  /** La quita sin dejar rastro (voz programada que ya no debe sonar). */
  cancel(): void {
    this.released = true
    this.endTime = this.startTime
    this.kill.disconnect()
    if (!this.stopScheduled) {
      this.stopScheduled = true
      try {
        this.source.stop()
      } catch {
        // Ya estaba parada.
      }
    }
  }
}
