/**
 * Verificación objetiva sobre audio renderizado: como nadie puede escuchar
 * aquí, se usan impulsos y señales constantes como samples y se mide en qué
 * frame empieza y termina cada cosa.
 */
import { describe, expect, it } from 'vitest'
import {
  PPQ,
  gridTicks,
  newId,
  ticksToSeconds,
  type AudioClip,
  type ClipId,
  type InstrumentEvent,
  type Project,
  type TrackId,
} from '../model'
import { DEFAULT_MIXER } from '../model'
import { renderOffline } from './offline'
import { LruRenderCache } from './renderCache'
import { applySwing } from './swing'
import {
  ProjectBuilder,
  SR,
  bufferOf,
  createRig,
  dc,
  impulse,
  lastActive,
  note,
  offlineContext,
  onsets,
} from './testing'

const scratch = () => offlineContext(0.01)

async function render(b: ProjectBuilder, seconds: number, fromTick = 0): Promise<AudioBuffer> {
  return renderOffline(b.project, b.buffers, {
    sampleRate: SR,
    durationSec: seconds,
    fromTick,
    createContext: (channels, length, sampleRate) =>
      offlineContext(length / sampleRate, channels, sampleRate),
  })
}

function expectFrames(actual: number[], expected: number[], tolerance = 1): void {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((frame, i) => {
    expect(Math.abs(frame - expected[i]!), `golpe ${i}: ${frame} vs ${expected[i]}`).toBeLessThanOrEqual(
      tolerance,
    )
  })
}

const frameOf = (ticks: number, bpm: number) => Math.round(ticksToSeconds(ticks, bpm) * SR)

describe('render offline: los golpes caen en el frame esperado (±1)', () => {
  it('semicorcheas a un tempo que no cae en frames enteros, varias vueltas', async () => {
    const bpm = 93
    const b = new ProjectBuilder(scratch(), bpm)
    const drums = b.drumRack()
    const g = gridTicks(16)
    b.pattern(drums.id, [note(0), note(g), note(5 * g), note(15 * g)], PPQ * 4)
    const out = await render(b, 8)
    const expected: number[] = []
    for (let bar = 0; bar < 4; bar++) {
      for (const step of [0, 1, 5, 15]) {
        const f = frameOf(bar * PPQ * 4 + step * g, bpm)
        if (f < 8 * SR) expected.push(f)
      }
    }
    expectFrames(onsets(out.getChannelData(0)), expected)
  })

  it('dos pistas con patrones de largo distinto', async () => {
    const b = new ProjectBuilder(scratch(), 120)
    const left = b.drumRack()
    const right = b.drumRack()
    left.mixer = { ...DEFAULT_MIXER, pan: -1 }
    right.mixer = { ...DEFAULT_MIXER, pan: 1 }
    b.pattern(left.id, [note(0)], PPQ * 1.5)
    b.pattern(right.id, [note(PPQ / 4)], PPQ)
    const out = await render(b, 3)
    expectFrames(
      onsets(out.getChannelData(0)),
      [0, 0.75, 1.5, 2.25].map((s) => s * SR),
    )
    expectFrames(
      onsets(out.getChannelData(1)),
      [0.125, 0.625, 1.125, 1.625, 2.125, 2.625].map((s) => s * SR),
    )
  })

  it('swing del patrón aplicado al reproducir', async () => {
    const b = new ProjectBuilder(scratch(), 100)
    const drums = b.drumRack()
    const g = gridTicks(16)
    const pattern = b.pattern(
      drums.id,
      [0, 1, 2, 3].map((k) => note(k * g)),
      PPQ,
    )
    pattern.swing = 0.5
    const out = await render(b, 0.6)
    expectFrames(
      onsets(out.getChannelData(0)),
      [0, 1, 2, 3].map((k) => frameOf(applySwing(k * g, 0.5, g), 100)),
    )
  })

  it('cambio de BPM a media reproducción', async () => {
    const b = new ProjectBuilder(scratch(), 120)
    const drums = b.drumRack()
    b.pattern(drums.id, [note(0)], PPQ)
    const rig = createRig(4, b.buffers)
    rig.engine.setProject(b.project)
    rig.engine.play()
    rig.engine.advanceTo(1.2) // tick 2304
    rig.engine.setProject({ ...b.project, bpm: 90 })
    rig.engine.advanceTo(4)
    const out = await rig.ctx.startRendering()
    // Tras el cambio faltan 576 ticks para el tick 2880, ya a 90 BPM.
    const next = 1.2 + ticksToSeconds(576, 90)
    const beat = ticksToSeconds(PPQ, 90)
    const expected = [0, 0.5, 1, next, next + beat, next + 2 * beat, next + 3 * beat]
    expectFrames(
      onsets(out.getChannelData(0)),
      expected.map((s) => Math.round(s * SR)),
    )
  })

  it('un evento en vivo con tiempo en el pasado se toca ya', async () => {
    const b = new ProjectBuilder(scratch())
    const drums = b.drumRack()
    const rig = createRig(0.5, b.buffers)
    rig.engine.setProject(b.project)
    const target = { trackId: drums.id, pitch: 36 }
    rig.engine.handleEvent({ type: 'noteOn', time: -0.2, target, velocity: 127, source: 'live' })
    rig.engine.handleEvent({ type: 'noteOn', time: 0.25, target, velocity: 127, source: 'live' })
    const out = await rig.ctx.startRendering()
    expectFrames(onsets(out.getChannelData(0)), [0, 0.25 * SR])
  })
})

describe('drum rack: choke y one-shot / gate', () => {
  const LONG = SR / 2 // medio segundo

  function chokeProject(group: number | null) {
    const ctx = scratch()
    const b = new ProjectBuilder(ctx, 120)
    const drums = b.drumRack([dc(ctx, LONG), dc(ctx, 480)])
    drums.pads[0]!.chokeGroup = group
    drums.pads[1]!.chokeGroup = group
    // Pad largo en 0; pad corto a los 0.1 s.
    b.pattern(drums.id, [note(0, 36), note(PPQ / 5, 37)], PPQ * 8)
    return b
  }

  it('sin choke group el pad largo suena completo', async () => {
    const out = await render(chokeProject(null), 1)
    expect(lastActive(out.getChannelData(0))).toBeGreaterThan(LONG - 100)
  })

  it('pads del mismo choke group se cortan entre sí', async () => {
    const out = await render(chokeProject(1), 1)
    // El largo se corta a los 0.1 s; lo último que suena es el pad corto.
    const end = lastActive(out.getChannelData(0))
    expect(end).toBeGreaterThanOrEqual(4800 + 470)
    expect(end).toBeLessThanOrEqual(4800 + 481)
    // Y el corte es un fade corto, no un click: 1 ms después aún queda señal del largo.
    expect(out.getChannelData(0)[4800 + 48]).toBeGreaterThan(1.2)
  })

  function gateProject(mode: 'oneShot' | 'gate') {
    const ctx = scratch()
    const b = new ProjectBuilder(ctx, 120)
    const drums = b.drumRack([dc(ctx, LONG)])
    drums.pads[0]!.triggerMode = mode
    b.pattern(drums.id, [note(0, 36, PPQ / 4)], PPQ * 8) // la nota dura 0.125 s
    return b
  }

  it('one-shot: suena completo aunque la nota termine', async () => {
    const out = await render(gateProject('oneShot'), 1)
    expect(lastActive(out.getChannelData(0))).toBeGreaterThan(LONG - 100)
  })

  it('gate: se corta (con un fade corto) al terminar la nota', async () => {
    const out = await render(gateProject('gate'), 1)
    const end = lastActive(out.getChannelData(0))
    expect(end).toBeGreaterThanOrEqual(6000)
    expect(end).toBeLessThanOrEqual(6000 + 0.006 * SR)
  })
})

describe('slicer', () => {
  function slicerProject() {
    const ctx = scratch()
    const b = new ProjectBuilder(ctx, 120)
    // Dos mitades con niveles distintos para saber cuál suena.
    const data = new Float32Array(9600)
    data.fill(0.25, 0, 4800).fill(0.5, 4800)
    const asset = b.asset(bufferOf(ctx, data), [
      [0, 4800],
      [4800, 9600],
    ])
    const slicer = b.slicer(asset)
    return { b, slicer, asset }
  }

  it('slice i = baseNote + i, con micro-fade en los cortes', async () => {
    const { b, slicer } = slicerProject()
    b.pattern(slicer.id, [note(0, 37), note(PPQ, 36)], PPQ * 8)
    const out = await render(b, 1)
    const data = out.getChannelData(0)
    // El slice 1 empieza en un corte dentro del audio: entra con fade de 2 ms.
    expect(data[0]).toBeCloseTo(0, 3)
    expect(data[48]).toBeCloseTo(0.25, 1)
    expect(data[200]).toBeCloseTo(0.5, 3)
    expect(data[5000]).toBeCloseTo(0, 5)
    // El slice 0 empieza en el inicio real del archivo: sin fade de entrada.
    expect(data[0.5 * SR + 2]).toBeCloseTo(0.25, 3)
    // …y termina en un corte: sale con fade.
    expect(data[0.5 * SR + 4800 - 48]).toBeLessThan(0.2)
    expectFrames(onsets(data, 0.001, 100), [1, 0.5 * SR])
  })

  it('monophonic: un slice nuevo corta al anterior', async () => {
    const { b, slicer } = slicerProject()
    b.pattern(slicer.id, [note(0, 36), note(PPQ / 10, 37)], PPQ * 8) // segundo a los 0.05 s
    slicer.monophonic = true
    const mono = (await render(b, 0.5)).getChannelData(0)
    slicer.monophonic = false
    const poly = (await render(b, 0.5)).getChannelData(0)
    expect(poly[2400 + 1000]).toBeCloseTo(0.75, 3)
    expect(mono[2400 + 1000]).toBeCloseTo(0.5, 3)
  })
})

describe('sampler (resample)', () => {
  function samplerProject(frames = 4800) {
    const ctx = scratch()
    const b = new ProjectBuilder(ctx, 120)
    const asset = b.asset(dc(ctx, frames))
    const sampler = b.sampler(asset)
    return { b, sampler, asset, ctx }
  }

  it('una octava arriba dura la mitad; una abajo, el doble', async () => {
    for (const [pitch, frames] of [
      [60, 4800],
      [72, 2400],
      [48, 9600],
    ] as const) {
      const { b, sampler } = samplerProject()
      b.pattern(sampler.id, [note(0, pitch, PPQ * 4)], PPQ * 8)
      const out = await render(b, 1)
      expect(Math.abs(lastActive(out.getChannelData(0)) - frames)).toBeLessThanOrEqual(2)
    }
  })

  it('loop de sostenido: suena mientras dura la nota y luego hace release', async () => {
    const { b, sampler } = samplerProject()
    sampler.loop = { enabled: true, start: 1000, end: 3000 }
    b.pattern(sampler.id, [note(0, 60, PPQ)], PPQ * 8) // 0.5 s; el sample dura 0.1 s
    const out = await render(b, 1)
    const end = lastActive(out.getChannelData(0))
    expect(end).toBeGreaterThanOrEqual(0.5 * SR)
    expect(end).toBeLessThanOrEqual(0.5 * SR + 0.005 * SR + 2)
    expect(out.getChannelData(0)[0.4 * SR]).toBeCloseTo(1, 3)
  })

  it('ADSR: ataque, caída al nivel de sustain y release', async () => {
    const { b, sampler } = samplerProject(SR)
    sampler.envelope = { attackMs: 10, decayMs: 20, sustain: 0.5, releaseMs: 40 }
    b.pattern(sampler.id, [note(0, 60, PPQ / 2)], PPQ * 8) // suelta a los 0.25 s
    const data = (await render(b, 1)).getChannelData(0)
    expect(data[0.005 * SR]).toBeCloseTo(0.5, 2)
    expect(data[0.01 * SR]).toBeCloseTo(1, 2)
    expect(data[0.02 * SR]).toBeCloseTo(0.75, 2)
    expect(data[0.1 * SR]).toBeCloseTo(0.5, 3)
    expect(data[0.27 * SR]).toBeCloseTo(0.25, 2)
    expect(lastActive(data)).toBeLessThanOrEqual(0.29 * SR + 2)
  })

  const live = (trackId: TrackId, type: 'noteOn' | 'noteOff', pitch: number, time: number) =>
    ({ type, time, target: { trackId, pitch }, velocity: 127, source: 'live' }) as InstrumentEvent

  it('poly: al pasar de maxVoices se roba la voz más antigua', async () => {
    const { b, sampler } = samplerProject(SR)
    sampler.maxVoices = 2
    const rig = createRig(0.5, b.buffers)
    rig.engine.setProject(b.project)
    for (const [i, pitch] of [60, 60.01, 60.02, 60.03].entries()) {
      rig.engine.handleEvent(live(sampler.id, 'noteOn', pitch, i * 0.1))
    }
    const data = (await rig.ctx.startRendering()).getChannelData(0)
    expect(data[0.05 * SR]).toBeCloseTo(1, 3)
    expect(data[0.15 * SR]).toBeCloseTo(2, 3)
    expect(data[0.25 * SR]).toBeCloseTo(2, 3)
    expect(data[0.35 * SR]).toBeCloseTo(2, 3)
  })

  it('mono sin glide re-dispara; con glide hace legato sin re-disparar', async () => {
    for (const glideMs of [0, 50]) {
      const { b, sampler } = samplerProject(SR)
      sampler.voiceMode = 'mono'
      sampler.glideMs = glideMs
      sampler.envelope = { attackMs: 20, decayMs: 0, sustain: 1, releaseMs: 5 }
      const rig = createRig(0.5, b.buffers)
      rig.engine.setProject(b.project)
      rig.engine.handleEvent(live(sampler.id, 'noteOn', 60, 0))
      rig.engine.handleEvent(live(sampler.id, 'noteOn', 67, 0.2))
      rig.engine.handleEvent(live(sampler.id, 'noteOff', 67, 0.3))
      rig.engine.handleEvent(live(sampler.id, 'noteOff', 60, 0.4))
      const data = (await rig.ctx.startRendering()).getChannelData(0)
      expect(data[0.1 * SR]).toBeCloseTo(1, 3)
      // 5 ms después de la segunda nota: con re-disparo el ataque va por 1/4
      // (más la cola del corte); con legato el nivel no se mueve.
      if (glideMs === 0) expect(data[0.205 * SR]).toBeLessThan(0.5)
      else expect(data[0.205 * SR]).toBeCloseTo(1, 3)
      // Al soltar la segunda vuelve a la primera, que sigue pulsada.
      expect(data[0.38 * SR]).toBeCloseTo(1, 3)
      // Nunca hay más de una voz.
      expect(Math.max(...data)).toBeLessThan(1.3)
      expect(lastActive(data)).toBeLessThanOrEqual(0.405 * SR + 2)
    }
  })

  it('pedal de sustain: retiene las notas soltadas hasta que se levanta', async () => {
    const { b, sampler } = samplerProject(SR)
    const rig = createRig(0.5, b.buffers)
    rig.engine.setProject(b.project)
    const pedal = (on: boolean, time: number): InstrumentEvent => ({
      type: 'sustain',
      time,
      trackId: sampler.id,
      on,
      source: 'live',
    })
    rig.engine.handleEvent(pedal(true, 0))
    rig.engine.handleEvent(live(sampler.id, 'noteOn', 60, 0))
    rig.engine.handleEvent(live(sampler.id, 'noteOff', 60, 0.1))
    rig.engine.handleEvent(pedal(false, 0.3))
    const data = (await rig.ctx.startRendering()).getChannelData(0)
    expect(data[0.25 * SR]).toBeCloseTo(1, 3)
    expect(lastActive(data)).toBeLessThanOrEqual(0.305 * SR + 2)
    expect(lastActive(data)).toBeGreaterThanOrEqual(0.3 * SR)
  })

  it('preserve: usa el render de la caché si existe; si no, cae a resample', async () => {
    const { b, sampler, asset, ctx } = samplerProject()
    sampler.pitchMode = 'preserve'
    b.pattern(sampler.id, [note(0, 72, PPQ * 4)], PPQ * 8)
    const requested: number[] = []
    const cache = new LruRenderCache({ maxBytes: 1e6 })
    const renders = {
      get: cache.get.bind(cache),
      request: (key: { semitones: number }) => requested.push(key.semitones),
    }
    const options = {
      sampleRate: SR,
      durationSec: 0.5,
      renders,
      createContext: (c: number, l: number, sr: number) => offlineContext(l / sr, c, sr),
    }
    // Sin render: fallback a resample (dura la mitad) y se pide el render.
    const fallback = await renderOffline(b.project, b.buffers, options)
    expect(Math.abs(lastActive(fallback.getChannelData(0)) - 2400)).toBeLessThanOrEqual(2)
    expect(requested).toEqual([12])
    // Con render: suena ese buffer a velocidad 1 (misma duración, otro contenido).
    cache.set(
      { assetId: asset.id, start: 0, end: 4800, stretchRatio: 1, semitones: 12, mode: 'preserve' },
      dc(ctx, 4800, 0.3),
    )
    const preserved = (await renderOffline(b.project, b.buffers, options)).getChannelData(0)
    expect(preserved[1000]).toBeCloseTo(0.3, 3)
    expect(lastActive(preserved)).toBeGreaterThan(4700)
  })
})

describe('PlaybackOptions', () => {
  it('reverse, ganancia y tono del pad', async () => {
    const ctx = scratch()
    const b = new ProjectBuilder(ctx, 120)
    const ramp = Float32Array.from({ length: 4800 }, (_, i) => i / 4800)
    const drums = b.drumRack([bufferOf(ctx, ramp), dc(ctx, 4800)])
    drums.mixer = { ...DEFAULT_MIXER, pan: -1 }
    drums.pads[0]!.playback = { ...drums.pads[0]!.playback, reverse: true, gainDb: -6.0206 }
    drums.pads[1]!.playback = { ...drums.pads[1]!.playback, pitch: 12, fadeOutMs: 10 }
    b.pattern(drums.id, [note(0, 36), note(PPQ, 37)], PPQ * 8)
    const data = (await render(b, 1)).getChannelData(0)
    // En reversa la rampa empieza arriba y baja; a -6 dB, la mitad.
    expect(data[0]).toBeCloseTo(0.5, 2)
    expect(data[2400]).toBeCloseTo(0.25, 2)
    // +12 semitonos: dura la mitad, con su fade-out de 10 ms.
    const start = 0.5 * SR
    expect(data[start + 1000]).toBeCloseTo(1, 3)
    expect(data[start + 2400 - 240]).toBeCloseTo(0.5, 1)
    expect(Math.abs(lastActive(data) - (start + 2400))).toBeLessThanOrEqual(3)
  })
})

describe('mixer en el render', () => {
  it('mute, solo, volumen y paneo', async () => {
    const ctx = scratch()
    const b = new ProjectBuilder(ctx, 120)
    const a = b.drumRack([dc(ctx, 4800)])
    const c = b.drumRack([dc(ctx, 4800)])
    b.pattern(a.id, [note(0)], PPQ * 8)
    b.pattern(c.id, [note(PPQ)], PPQ * 8)
    const levels = async () => {
      const out = await render(b, 1)
      const l = out.getChannelData(0)
      const r = out.getChannelData(1)
      return [l[1000]!, r[1000]!, l[0.5 * SR + 1000]!, r[0.5 * SR + 1000]!].map(
        (x) => Math.round(x * 1000) / 1000,
      )
    }
    const center = Math.round(Math.SQRT1_2 * 1000) / 1000
    expect(await levels()).toEqual([center, center, center, center])
    a.mixer = { ...DEFAULT_MIXER, mute: true }
    expect(await levels()).toEqual([0, 0, center, center])
    a.mixer = { ...DEFAULT_MIXER, solo: true }
    expect(await levels()).toEqual([center, center, 0, 0])
    a.mixer = { ...DEFAULT_MIXER, pan: -1, volumeDb: -6.0206 }
    c.mixer = { ...DEFAULT_MIXER, pan: 1 }
    b.project.master = { volumeDb: -6.0206 }
    expect(await levels()).toEqual([0.25, 0, 0, 0.5])
  })
})

describe('pistas de audio', () => {
  function audioProject(warp: AudioClip['warp'], lengthTicks: number, bpm: number) {
    const ctx = scratch()
    const b = new ProjectBuilder(ctx, bpm)
    const asset = b.asset(dc(ctx, SR)) // 1 s de audio
    const track = b.track({
      id: newId<TrackId>(),
      kind: 'audio',
      name: 'Audio',
      color: '#fff',
      mixer: { ...DEFAULT_MIXER, pan: -1 },
      armed: false,
      activePatternId: null,
    })
    const clip: AudioClip = {
      id: newId<ClipId>(),
      kind: 'audio',
      trackId: track.id,
      sample: { kind: 'asset', assetId: asset.id },
      startTick: PPQ,
      lengthTicks,
      offsetTicks: 0,
      warp,
      gainDb: 0,
    }
    b.project.clips = { [clip.id]: clip }
    b.project.transportMode = 'song'
    return { b, clip }
  }
  const bounds = (out: AudioBuffer) => {
    const data = out.getChannelData(0)
    return [onsets(data, 0.001, 1e9)[0]!, lastActive(data)]
  }

  it('warp off: empieza en su tick y suena a velocidad original', async () => {
    const { b } = audioProject({ mode: 'off', sourceBpm: null, semitones: 0 }, PPQ * 16, 60)
    const [start, end] = bounds(await render(b, 4))
    expect(Math.abs(start! - SR)).toBeLessThanOrEqual(1)
    expect(Math.abs(end! - 2 * SR)).toBeLessThanOrEqual(2)
  })

  it('warp resample: velocidad = BPM proyecto / BPM origen', async () => {
    // Audio a 120 en un proyecto a 60: dura el doble (2 s).
    const { b } = audioProject({ mode: 'resample', sourceBpm: 120, semitones: 0 }, PPQ * 16, 60)
    const [start, end] = bounds(await render(b, 4))
    expect(Math.abs(start! - SR)).toBeLessThanOrEqual(1)
    expect(Math.abs(end! - 3 * SR)).toBeLessThanOrEqual(2)
  })

  it('el clip corta el audio en su final (con micro-fade)', async () => {
    const { b } = audioProject({ mode: 'off', sourceBpm: null, semitones: 0 }, PPQ / 2, 60)
    const [, end] = bounds(await render(b, 4))
    expect(end!).toBeGreaterThanOrEqual(1.5 * SR)
    expect(end!).toBeLessThanOrEqual(1.5 * SR + 0.005 * SR + 1)
  })

  it('arrancar a medio clip entra en el punto correcto del audio', async () => {
    const { b } = audioProject({ mode: 'off', sourceBpm: null, semitones: 0 }, PPQ * 16, 60)
    // Arranca 0.25 s dentro del clip: quedan 0.75 s de audio.
    const [start, end] = bounds(await render(b, 4, PPQ * 1.25))
    expect(start!).toBeLessThanOrEqual(2)
    expect(Math.abs(end! - 0.75 * SR)).toBeLessThanOrEqual(2)
  })

  it('warp resample: un cambio de BPM a medio clip cambia su velocidad sin saltos', async () => {
    const { b, clip } = audioProject({ mode: 'resample', sourceBpm: 120, semitones: 0 }, PPQ * 16, 120)
    // El valor de cada muestra es su posición en segundos dentro del audio.
    const ramp = Float32Array.from({ length: SR }, (_, i) => i / SR)
    b.buffers.set(clip.sample.assetId, bufferOf(scratch(), ramp))
    b.project.clips = { [clip.id]: { ...clip, startTick: 0 } }
    const rig = createRig(2, b.buffers)
    rig.engine.setProject(b.project)
    rig.engine.play()
    rig.engine.advanceTo(0.5)
    rig.engine.setProject({ ...b.project, bpm: 60 })
    rig.engine.advanceTo(2)
    const data = (await rig.ctx.startRendering()).getChannelData(0)
    expect(data[0.25 * SR]).toBeCloseTo(0.25, 3)
    // Desde 0.5 s va a mitad de velocidad.
    expect(data[1 * SR]).toBeCloseTo(0.75, 2)
    expect(data[1.4 * SR]).toBeCloseTo(0.95, 2)
  })

  it('songLoop: el clip se corta en la vuelta y vuelve a entrar', async () => {
    const { b } = audioProject({ mode: 'off', sourceBpm: null, semitones: 0 }, PPQ * 16, 60)
    const project: Project = {
      ...b.project,
      songLoop: { enabled: true, startTick: PPQ * 0.5, endTick: PPQ * 1.5 },
    }
    b.project = project
    const data = (await render(b, 3)).getChannelData(0)
    // Posición: 0→1.5 (1.5 s), luego 0.5→1.5 cada segundo. El clip (tick 960 = 1 s)
    // suena de 1.0 a 1.5 s y de 2.0 a 2.5 s.
    expectFrames(onsets(data, 0.001, 2000), [SR, 2 * SR])
    expect(data[1.25 * SR]).toBeCloseTo(1, 3)
    expect(data[1.75 * SR]).toBeCloseTo(0, 3)
    expect(data[2.25 * SR]).toBeCloseTo(1, 3)
  })
})

describe('metrónomo', () => {
  it('clic generado en cada tiempo, también durante el count-in', async () => {
    const b = new ProjectBuilder(scratch(), 120)
    b.project.metronome = { enabled: true, countInBars: 1, volumeDb: 0, sample: null }
    const drums = b.drumRack([impulse(scratch())])
    drums.mixer = { ...DEFAULT_MIXER, mute: true }
    const ctx = offlineContext(3)
    const rig = createRig(3, b.buffers, { context: ctx, metronomeOutput: ctx.destination })
    rig.engine.setProject(b.project)
    rig.engine.play({ countInBars: 1 })
    rig.engine.advanceTo(3)
    const data = (await ctx.startRendering()).getChannelData(0)
    // El seno arranca en 0: el primer frame por encima del umbral es el siguiente.
    expectFrames(
      onsets(data, 0.01, 4000),
      [0, 0.5, 1, 1.5, 2, 2.5].map((s) => s * SR + 1),
      2,
    )
  })
})
