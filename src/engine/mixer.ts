/**
 * Mixer básico: por pista ganancia → paneo → master → salida.
 * Mute y solo se resuelven aquí: si hay algún solo, solo suenan las pistas
 * en solo; mute gana siempre.
 */
import type { Project, Track, TrackId } from '../model'
import { clamp, dbToGain } from './util'

/** Suavizado de los cambios en vivo para que no hagan click. */
const SMOOTH_SEC = 0.005

interface Channel {
  input: GainNode
  pan: StereoPannerNode
  gain: number
  panValue: number
}

/** Ganancia efectiva de una pista (0 si está muteada o tapada por un solo). Pura. */
export function trackGain(track: Track, anySolo: boolean): number {
  if (track.mixer.mute) return 0
  if (anySolo && !track.mixer.solo) return 0
  return dbToGain(track.mixer.volumeDb)
}

export class Mixer {
  readonly master: GainNode
  private readonly ctx: BaseAudioContext
  private readonly channels = new Map<TrackId, Channel>()
  private masterGain: number | null = null

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.connect(destination)
  }

  /** Entrada del canal de la pista (donde se conectan sus voces). */
  input(trackId: TrackId): AudioNode | undefined {
    return this.channels.get(trackId)?.input
  }

  /** Pone el mixer como dice el proyecto: crea, ajusta y quita canales. */
  sync(project: Project): void {
    const now = this.ctx.currentTime
    const master = dbToGain(project.master.volumeDb)
    if (this.masterGain === null) this.master.gain.value = master
    else if (master !== this.masterGain) this.master.gain.setTargetAtTime(master, now, SMOOTH_SEC)
    this.masterGain = master
    const tracks = Object.values(project.tracks)
    const anySolo = tracks.some((t) => t.mixer.solo)
    for (const track of tracks) {
      const gain = trackGain(track, anySolo)
      const panValue = clamp(track.mixer.pan, -1, 1)
      let ch = this.channels.get(track.id)
      if (!ch) {
        const input = this.ctx.createGain()
        const pan = this.ctx.createStereoPanner()
        input.gain.value = gain
        pan.pan.value = panValue
        input.connect(pan)
        pan.connect(this.master)
        ch = { input, pan, gain, panValue }
        this.channels.set(track.id, ch)
        continue
      }
      if (gain !== ch.gain) {
        ch.gain = gain
        ch.input.gain.setTargetAtTime(gain, now, SMOOTH_SEC)
      }
      if (panValue !== ch.panValue) {
        ch.panValue = panValue
        ch.pan.pan.setTargetAtTime(panValue, now, SMOOTH_SEC)
      }
    }
    for (const [id, ch] of this.channels) {
      if (!project.tracks[id]) {
        ch.pan.disconnect()
        this.channels.delete(id)
      }
    }
  }

  dispose(): void {
    for (const ch of this.channels.values()) ch.pan.disconnect()
    this.channels.clear()
    this.master.disconnect()
  }
}
