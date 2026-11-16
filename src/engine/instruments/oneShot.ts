/**
 * Drum Rack y Slicer: los dos disparan una porción de audio por nota, con
 * modo one-shot o gate. Solo cambia de dónde sale la porción y quién corta
 * a quién, así que comparten casi todo.
 */
import type {
  DrumRackTrack,
  InstrumentEvent,
  PlaybackOptions,
  SampleRef,
  SlicerTrack,
  Track,
  TriggerMode,
} from '../../model'
import { effectiveFades, makeRegion, resolveSampleRef } from '../sample'
import { dbToGain, semitonesToRate, velocityToGain } from '../util'
import { CUT_FADE_SEC, Voice } from '../voice'
import { MAX_ONE_SHOT_VOICES, VoiceList, type Instrument, type InstrumentDeps } from './instrument'

interface Hit {
  sample: SampleRef | null
  /** Ajustes de quien usa la referencia (los del slice ya vienen con ella). */
  playback?: PlaybackOptions
  triggerMode: TriggerMode
  /** Grupo cuyas voces se cortan al sonar este golpe. null = ninguno. */
  chokeGroup: number | null
}

abstract class OneShotInstrument implements Instrument {
  protected readonly deps: InstrumentDeps
  private readonly list = new VoiceList()

  constructor(deps: InstrumentDeps) {
    this.deps = deps
  }

  abstract setTrack(track: Track): void
  /** Qué suena con esta altura, o null si nada. */
  protected abstract hitFor(pitch: number): Hit | null

  handle(event: InstrumentEvent): void {
    if (event.type === 'sustain') return
    const { ctx } = this.deps
    const time = Math.max(event.time, ctx.currentTime)
    const pitch = event.target.pitch
    const hit = this.hitFor(pitch)
    if (!hit) return

    if (event.type === 'noteOff') {
      for (const v of this.list.voices) {
        if (v.key === pitch && v.gate && !v.released && v.startTime <= time) {
          v.release(time, Math.max(CUT_FADE_SEC, v.gateReleaseSec))
        }
      }
      return
    }

    this.list.prune(time)
    if (hit.chokeGroup !== null) {
      for (const v of this.list.voices) {
        if (v.group === hit.chokeGroup && v.startTime <= time) v.release(time, CUT_FADE_SEC)
      }
    }
    const resolved = resolveSampleRef(this.deps.getAssets(), hit.sample, hit.playback)
    if (!resolved) return
    const buffer = this.deps.buffers.getBuffer(resolved.assetId)
    if (!buffer) return
    const { playback } = resolved
    const region = makeRegion(
      ctx,
      this.deps.reverse,
      buffer,
      resolved.start,
      resolved.end,
      playback.reverse,
    )
    if (!region) return
    const fades = effectiveFades(region, playback)
    const voice = new Voice(ctx, this.deps.output, {
      region,
      when: time,
      gain: velocityToGain(event.velocity) * dbToGain(playback.gainDb),
      playbackRate: semitonesToRate(playback.pitch),
      ...fades,
    })
    voice.key = pitch
    voice.group = hit.chokeGroup
    voice.gate = hit.triggerMode === 'gate'
    voice.gateReleaseSec = fades.fadeOutSec
    this.list.add(voice, time, MAX_ONE_SHOT_VOICES)
  }

  cancelFuture(time: number): void {
    this.list.cancelFuture(time)
  }

  panic(time: number): void {
    this.list.panic(time)
  }
}

/** Pad i = baseNote + i. Los pads de un mismo choke group se cortan entre sí. */
export class DrumRackInstrument extends OneShotInstrument {
  private track: DrumRackTrack

  constructor(deps: InstrumentDeps, track: DrumRackTrack) {
    super(deps)
    this.track = track
  }

  setTrack(track: Track): void {
    if (track.kind === 'drumRack') this.track = track
  }

  protected hitFor(pitch: number): Hit | null {
    const pad = this.track.pads[pitch - this.track.baseNote]
    if (!pad) return null
    return {
      sample: pad.sample,
      playback: pad.playback,
      triggerMode: pad.triggerMode,
      chokeGroup: pad.chokeGroup,
    }
  }
}

/** Slice i del asset = baseNote + i. En `monophonic` toda la pista es un choke group. */
export class SlicerInstrument extends OneShotInstrument {
  private track: SlicerTrack

  constructor(deps: InstrumentDeps, track: SlicerTrack) {
    super(deps)
    this.track = track
  }

  setTrack(track: Track): void {
    if (track.kind === 'slicer') this.track = track
  }

  protected hitFor(pitch: number): Hit | null {
    const { assetId, baseNote, triggerMode, monophonic } = this.track
    if (!assetId) return null
    const slice = this.deps.getAssets()[assetId]?.slices[pitch - baseNote]
    if (!slice) return null
    return {
      sample: { kind: 'slice', assetId, sliceId: slice.id },
      triggerMode,
      chokeGroup: monophonic ? 0 : null,
    }
  }
}
