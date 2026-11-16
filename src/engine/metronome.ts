/**
 * Metrónomo. El clic se genera (un seno corto con caída exponencial, más
 * agudo en el primer tiempo del compás) o usa el SampleRef del proyecto.
 * Va directo a la salida, sin pasar por el master, para que no entre en un
 * export ni dependa del volumen de la mezcla.
 */
import { ticksPerBeat, type Project } from '../model'
import { makeRegion, resolveSampleRef, type BufferProvider, type ReverseCache } from './sample'
import { dbToGain, posMod, semitonesToRate } from './util'
import { Voice } from './voice'

const CLICK_SEC = 0.03
const ACCENT_HZ = 1760
const BEAT_HZ = 880
/** Los tiempos que no son el primero del compás suenan más bajo. */
const BEAT_GAIN = 0.6

export interface Beat {
  tick: number
  /** Primer tiempo del compás. */
  accent: boolean
}

/** Tiempos (pulsos del compás) que caen en [from, to). Los compases cuentan desde el tick 0. Pura. */
export function beatsInWindow(project: Project, from: number, to: number): Beat[] {
  const beat = ticksPerBeat(project.timeSignature)
  const out: Beat[] = []
  for (let n = Math.ceil(from / beat); n * beat < to; n++) {
    out.push({ tick: n * beat, accent: posMod(n, project.timeSignature.numerator) === 0 })
  }
  return out
}

function makeClick(ctx: BaseAudioContext, hz: number): AudioBuffer {
  const length = Math.round(CLICK_SEC * ctx.sampleRate)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) {
    const t = i / ctx.sampleRate
    data[i] = Math.sin(2 * Math.PI * hz * t) * Math.exp(-t / 0.006)
  }
  return buffer
}

export class Metronome {
  private readonly ctx: BaseAudioContext
  private readonly output: AudioNode
  private readonly buffers: BufferProvider
  private readonly reverse: ReverseCache
  private accentClick: AudioBuffer | null = null
  private beatClick: AudioBuffer | null = null
  private voices: Voice[] = []

  constructor(
    ctx: BaseAudioContext,
    output: AudioNode,
    buffers: BufferProvider,
    reverse: ReverseCache,
  ) {
    this.ctx = ctx
    this.output = output
    this.buffers = buffers
    this.reverse = reverse
  }

  click(time: number, accent: boolean, project: Project): void {
    const { ctx } = this
    const when = Math.max(time, ctx.currentTime)
    const volume = dbToGain(project.metronome.volumeDb) * (accent ? 1 : BEAT_GAIN)
    this.voices = this.voices.filter((v) => v.aliveAt(when))

    const resolved = resolveSampleRef(project.assets, project.metronome.sample)
    const custom = resolved && this.buffers.getBuffer(resolved.assetId)
    if (resolved && custom) {
      const { playback } = resolved
      const region = makeRegion(
        ctx,
        this.reverse,
        custom,
        resolved.start,
        resolved.end,
        playback.reverse,
      )
      if (region) {
        this.voices.push(
          new Voice(ctx, this.output, {
            region,
            when,
            gain: volume * dbToGain(playback.gainDb),
            playbackRate: semitonesToRate(playback.pitch),
            fadeInSec: 0,
            fadeOutSec: 0,
          }),
        )
        return
      }
    }
    this.accentClick ??= makeClick(ctx, ACCENT_HZ)
    this.beatClick ??= makeClick(ctx, BEAT_HZ)
    const buffer = accent ? this.accentClick : this.beatClick
    this.voices.push(
      new Voice(ctx, this.output, {
        region: {
          buffer,
          startFrame: 0,
          endFrame: buffer.length,
          startIsCut: false,
          endIsCut: false,
        },
        when,
        gain: volume,
        playbackRate: 1,
        fadeInSec: 0,
        fadeOutSec: 0,
      }),
    )
  }

  /** Quita los clics programados que aún no suenan. */
  cancelFuture(time: number): void {
    for (const v of this.voices) if (v.startTime > time) v.cancel()
    this.voices = this.voices.filter((v) => v.aliveAt(time))
  }
}
