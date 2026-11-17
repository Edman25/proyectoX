/**
 * Mixer: por pista
 *
 *   entrada (volumen) → [filtro] → paneo ─┬──────────────▶ master
 *                                        ├─▶ envío delay ─▶ master
 *                                        └─▶ envío reverb ─▶ master
 *
 * y el master con una protección opcional al final: un saturador suave
 * (WaveShaper) en vez de un compresor, porque el compresor de Web Audio
 * tiene lookahead y retrasaría la mezcla respecto al metrónomo. Mute y solo se resuelven
 * aquí: si hay algún solo, solo suenan las pistas en solo; mute gana siempre.
 * Como el render offline usa este mismo mixer, el export suena igual.
 */
import { PPQ, type ChannelFx, type Project, type Track, type TrackId } from '../model'
import { clamp, dbToGain } from './util'

/**
 * Curva del saturador: lineal (sin tocar la señal) hasta 0.8 y de ahí
 * satura suave hacia 1. Sin latencia.
 */
export function softClipCurve(points = 4096): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points)
  const knee = 0.8
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 4 - 2 // entrada de -2 a 2
    const a = Math.abs(x)
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee))
    curve[i] = Math.sign(x) * y
  }
  return curve
}

/** Suavizado de los cambios en vivo para que no hagan click. */
const SMOOTH_SEC = 0.005
const MAX_DELAY_SEC = 4

interface FxNodes {
  filter: BiquadFilterNode
  delaySend: GainNode
  delay: DelayNode
  feedback: GainNode
  reverbSend: GainNode
  reverb: ConvolverNode
  /** Cómo está cableado ahora (para no recablear si no cambió). */
  wiring: string
  reverbSize: number
}

interface Channel {
  input: GainNode
  pan: StereoPannerNode
  gain: number
  panValue: number
  fx: FxNodes | null
}

/** Ganancia efectiva de una pista (0 si está muteada o tapada por un solo). Pura. */
export function trackGain(track: Track, anySolo: boolean): number {
  if (track.mixer.mute) return 0
  if (anySolo && !track.mixer.solo) return 0
  return dbToGain(track.mixer.volumeDb)
}

/**
 * Respuesta al impulso para la reverb: ruido estéreo con caída exponencial
 * (−60 dB al final de la cola). Determinista para que el export no cambie
 * de una vez a otra.
 */
export function reverbImpulse(ctx: BaseAudioContext, sizeSec: number): AudioBuffer {
  const sr = ctx.sampleRate
  const length = Math.max(1, Math.round(clamp(sizeSec, 0.1, 10) * sr))
  const buffer = ctx.createBuffer(2, length, sr)
  let seed = 12345
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2147483648 - 1
  }
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < length; i++) data[i] = rand() * Math.pow(10, (-3 * i) / length) * 0.5
  }
  return buffer
}

export class Mixer {
  readonly master: GainNode
  private readonly ctx: BaseAudioContext
  private readonly limiter: WaveShaperNode
  private readonly destination: AudioNode
  private readonly limiterIn: GainNode
  private readonly limiterOut: GainNode
  private readonly channels = new Map<TrackId, Channel>()
  private masterGain: number | null = null
  private limiterOn: boolean | null = null
  private readonly impulses = new Map<number, AudioBuffer>()

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.ctx = ctx
    this.destination = destination
    this.master = ctx.createGain()
    // El WaveShaper mapea [-1, 1] de su curva; se escala para cubrir [-2, 2].
    this.limiterIn = ctx.createGain()
    this.limiterIn.gain.value = 0.5
    this.limiter = ctx.createWaveShaper()
    this.limiter.curve = softClipCurve()
    this.limiterOut = ctx.createGain()
    this.limiterIn.connect(this.limiter)
    this.limiter.connect(this.limiterOut)
    this.limiterOut.connect(destination)
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
    const limiter = project.master.limiter ?? false
    if (limiter !== this.limiterOn) {
      this.master.disconnect()
      this.master.connect(limiter ? this.limiterIn : this.destination)
      this.limiterOn = limiter
    }

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
        pan.connect(this.master)
        ch = { input, pan, gain, panValue, fx: null }
        this.channels.set(track.id, ch)
        this.syncFx(ch, track.mixer.fx, project.bpm, true)
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
      this.syncFx(ch, track.mixer.fx, project.bpm, false)
    }
    for (const [id, ch] of this.channels) {
      if (!project.tracks[id]) {
        this.disposeChannel(ch)
        this.channels.delete(id)
      }
    }
  }

  private impulse(sizeSec: number): AudioBuffer {
    const key = Math.round(sizeSec * 10) / 10
    let ir = this.impulses.get(key)
    if (!ir) {
      ir = reverbImpulse(this.ctx, key)
      this.impulses.set(key, ir)
    }
    return ir
  }

  private syncFx(ch: Channel, fx: ChannelFx | undefined, bpm: number, initial: boolean): void {
    const ctx = this.ctx
    const now = ctx.currentTime
    const set = (param: AudioParam, value: number) => {
      if (initial) param.value = value
      else param.setTargetAtTime(value, now, SMOOTH_SEC * 4)
    }
    const filterOn = !!fx?.filter.enabled
    const delayOn = !!fx?.delay.enabled && fx.delay.mix > 0
    const reverbOn = !!fx?.reverb.enabled && fx.reverb.mix > 0

    if (fx && !ch.fx && (filterOn || delayOn || reverbOn)) {
      const delay = ctx.createDelay(MAX_DELAY_SEC)
      const feedback = ctx.createGain()
      const delaySend = ctx.createGain()
      const reverbSend = ctx.createGain()
      const reverb = ctx.createConvolver()
      delaySend.connect(delay)
      delay.connect(feedback)
      feedback.connect(delay)
      delay.connect(this.master)
      reverbSend.connect(reverb)
      reverb.connect(this.master)
      ch.fx = { filter: ctx.createBiquadFilter(), delaySend, delay, feedback, reverbSend, reverb, wiring: '', reverbSize: 0 }
      initial = true
    }

    // Cableado: solo se toca si cambió qué efectos están activos.
    const wiring = `${filterOn}|${delayOn}|${reverbOn}`
    const nodes = ch.fx
    if (!nodes) {
      if (initial) ch.input.connect(ch.pan)
      return
    }
    if (nodes.wiring !== wiring) {
      ch.input.disconnect()
      nodes.filter.disconnect()
      if (filterOn) {
        ch.input.connect(nodes.filter)
        nodes.filter.connect(ch.pan)
      } else ch.input.connect(ch.pan)
      ch.pan.disconnect()
      ch.pan.connect(this.master)
      if (delayOn) ch.pan.connect(nodes.delaySend)
      if (reverbOn) ch.pan.connect(nodes.reverbSend)
      nodes.wiring = wiring
    }
    if (!fx) return
    nodes.filter.type = fx.filter.type
    set(nodes.filter.frequency, clamp(fx.filter.cutoffHz, 20, 20000))
    set(nodes.filter.Q, clamp(fx.filter.q, 0.1, 20))
    set(nodes.delay.delayTime, clamp((fx.delay.timeTicks * 60) / (bpm * PPQ), 0.001, MAX_DELAY_SEC))
    set(nodes.feedback.gain, clamp(fx.delay.feedback, 0, 0.95))
    set(nodes.delaySend.gain, clamp(fx.delay.mix, 0, 1))
    set(nodes.reverbSend.gain, clamp(fx.reverb.mix, 0, 1))
    if (reverbOn && nodes.reverbSize !== fx.reverb.sizeSec) {
      nodes.reverb.buffer = this.impulse(fx.reverb.sizeSec)
      nodes.reverbSize = fx.reverb.sizeSec
    }
  }

  private disposeChannel(ch: Channel): void {
    ch.input.disconnect()
    ch.pan.disconnect()
    if (ch.fx) {
      ch.fx.filter.disconnect()
      ch.fx.delay.disconnect()
      ch.fx.feedback.disconnect()
      ch.fx.reverb.disconnect()
    }
  }

  dispose(): void {
    for (const ch of this.channels.values()) this.disposeChannel(ch)
    this.channels.clear()
    this.master.disconnect()
    this.limiter.disconnect()
  }
}
