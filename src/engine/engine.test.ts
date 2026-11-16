import { describe, expect, it } from 'vitest'
import {
  PPQ,
  newId,
  ticksToSeconds,
  type ClipId,
  type InstrumentEvent,
  type PatternClip,
  type Project,
} from '../model'
import { beatsInWindow } from './metronome'
import { trackGain } from './mixer'
import { ProjectBuilder, createRig, note, offlineContext, type TestRig } from './testing'

/** Avanza el scheduler en pasos pequeños, como haría el temporizador en vivo. */
function run(rig: TestRig, from: number, to: number, step = 0.025): void {
  for (let t = from; t < to; t += step) rig.engine.advanceTo(Math.min(to, t + step))
}

function setup(bpm = 120) {
  const b = new ProjectBuilder(offlineContext(0.1), bpm)
  const drums = b.drumRack()
  return { b, drums }
}

describe('transporte en modo patrón', () => {
  it('cada pista loopea su patrón con su propio largo, sin perder ni duplicar golpes', () => {
    const { b, drums } = setup(120)
    const other = b.drumRack()
    b.pattern(drums.id, [note(0, 36), note(PPQ, 37)], PPQ * 2) // 1 s por vuelta
    b.pattern(other.id, [note(0, 36), note(PPQ * 2.5, 38)], PPQ * 3) // 1.5 s por vuelta
    const rig = createRig(1, b.buffers)
    rig.engine.setProject(b.project)
    rig.engine.play()
    run(rig, 0, 6, 0.0137)

    const a = rig.ons().filter((e) => e.trackId === drums.id)
    const c = rig.ons().filter((e) => e.trackId === other.id)
    expect(a.map((e) => e.time)).toEqual(
      Array.from({ length: 12 }, (_, i) => expect.closeTo(i * 0.5, 9)),
    )
    expect(a.map((e) => e.pitch)).toEqual(Array.from({ length: 12 }, (_, i) => 36 + (i % 2)))
    const expected = [0, 1.25, 1.5, 2.75, 3, 4.25, 4.5, 5.75]
    expect(c.map((e) => e.time)).toEqual(expected.map((t) => expect.closeTo(t, 9)))
  })

  it('el resultado no depende del tamaño de los pasos del scheduler', () => {
    const times = [0.005, 0.025, 0.1, 0.7].map((step) => {
      const { b, drums } = setup(93)
      b.pattern(drums.id, [note(0), note(100), note(959)], 960)
      const rig = createRig(1, b.buffers)
      rig.engine.setProject(b.project)
      rig.engine.play()
      run(rig, 0, 5, step)
      return rig.ons().map((e) => Math.round(e.time * 1e9))
    })
    expect(times[0]!.length).toBeGreaterThan(20)
    for (const t of times) expect(t).toEqual(times[0])
  })

  it('cada note-on del secuenciador tiene su note-off, también al parar', () => {
    const { b, drums } = setup()
    b.pattern(drums.id, [note(0, 36, 100), note(900, 37, 500)], 960)
    const rig = createRig(1, b.buffers)
    rig.engine.setProject(b.project)
    rig.engine.play()
    run(rig, 0, 3.3)
    rig.engine.stop()
    const count = (type: InstrumentEvent['type']) => rig.events.filter((e) => e.type === type).length
    expect(count('noteOn')).toBeGreaterThan(10)
    expect(count('noteOff')).toBe(count('noteOn'))
    expect(rig.engine.isPlaying).toBe(false)
    expect(rig.timer.running).toBe(false)
  })

  it('notas añadidas o borradas en caliente: suenan (o no) desde la siguiente ventana, sin notas colgadas', () => {
    const { b, drums } = setup()
    const pattern = b.pattern(drums.id, [note(0, 36, 2000)], 960)
    const rig = createRig(1, b.buffers)
    rig.engine.setProject(b.project)
    rig.engine.play()
    run(rig, 0, 0.2)
    // Se borra la nota que está sonando y se añade otra.
    const edited: Project = {
      ...b.project,
      patterns: { [pattern.id]: { ...pattern, notes: [note(480, 40)] } },
    }
    rig.engine.setProject(edited)
    run(rig, 0.2, 1)
    expect(rig.ons().map((e) => [e.pitch, Math.round(e.time * 1000)])).toEqual([
      [36, 0],
      [40, 250],
      [40, 750],
    ])
    // La nota borrada recibió su note-off igualmente.
    const offs = rig.events.filter((e) => e.type === 'noteOff' && e.target.pitch === 36)
    expect(offs).toHaveLength(1)
    expect(offs[0]!.time).toBeCloseTo(0.5, 9)
  })
})

describe('cambio de BPM en vivo', () => {
  it('los golpes siguientes caen donde deben y la fase se conserva', () => {
    const { b, drums } = setup(120)
    b.pattern(drums.id, [note(0), note(PPQ / 2)], PPQ) // corcheas
    const rig = createRig(1, b.buffers)
    rig.engine.setProject(b.project)
    rig.engine.play()
    run(rig, 0, 1.1) // horizonte en 1.1 s = tick 2112
    rig.engine.setProject({ ...b.project, bpm: 60 })
    run(rig, 1.1, 4)

    const times = rig.ons().map((e) => e.time)
    // A 120: corcheas cada 0.25 s hasta 1.0.
    expect(times.slice(0, 5)).toEqual([0, 0.25, 0.5, 0.75, 1].map((t) => expect.closeTo(t, 9)))
    // El cambio entra en el horizonte (1.1 s, tick 2112). El siguiente golpe
    // es el tick 2400: faltan 288 ticks, ahora a 60 BPM.
    const next = 1.1 + ticksToSeconds(288, 60)
    expect(times[5]).toBeCloseTo(next, 9)
    expect(times[6]).toBeCloseTo(next + 0.5, 9)
    expect(times[7]).toBeCloseTo(next + 1, 9)
    // La posición es continua en el cambio.
    expect(rig.engine.tickAtTime(1.1)).toBeCloseTo(2112, 6)
    expect(rig.engine.tickAtTime(1.0)).toBeCloseTo(1920, 6)
    expect(rig.engine.tickAtTime(2.1)).toBeCloseTo(2112 + 960, 6)
  })

  it('varios cambios seguidos no pierden ni duplican golpes', () => {
    const { b, drums } = setup(100)
    b.pattern(drums.id, [note(0)], PPQ / 4)
    const rig = createRig(1, b.buffers)
    rig.engine.setProject(b.project)
    rig.engine.play()
    let project = b.project
    for (let i = 0; i < 100; i++) {
      project = { ...project, bpm: 80 + ((i * 37) % 120) }
      rig.engine.setProject(project)
      rig.engine.advanceTo((i + 1) * 0.033)
    }
    const end = rig.engine.tickAtTime(100 * 0.033)!
    expect(rig.ons()).toHaveLength(Math.ceil(end / (PPQ / 4)))
    const times = rig.ons().map((e) => e.time)
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!)
  })
})

describe('modo canción', () => {
  function songProject() {
    const { b, drums } = setup(120)
    const pattern = b.pattern(drums.id, [note(0, 36), note(PPQ, 37, 2000)], PPQ * 2)
    const clip = (startTick: number, lengthTicks: number, offsetTicks = 0): PatternClip => ({
      id: newId<ClipId>(),
      kind: 'pattern',
      trackId: drums.id,
      patternId: pattern.id,
      startTick,
      lengthTicks,
      offsetTicks,
    })
    b.project.transportMode = 'song'
    return { b, drums, clip }
  }

  it('toca los clips del arreglo; fuera de ellos, silencio', () => {
    const { b, clip } = songProject()
    const c1 = clip(PPQ * 2, PPQ * 4) // de 1 s a 3 s: dos vueltas del patrón
    const c2 = clip(PPQ * 8, PPQ * 2, PPQ) // de 4 s a 5 s, empezando en la mitad del patrón
    b.project.clips = { [c1.id]: c1, [c2.id]: c2 }
    const rig = createRig(1, b.buffers)
    rig.engine.setProject(b.project)
    rig.engine.play()
    run(rig, 0, 6)
    expect(rig.ons().map((e) => [e.pitch, e.time])).toEqual([
      [36, expect.closeTo(1, 9)],
      [37, expect.closeTo(1.5, 9)],
      [36, expect.closeTo(2, 9)],
      [37, expect.closeTo(2.5, 9)],
      [37, expect.closeTo(4, 9)],
      [36, expect.closeTo(4.5, 9)],
    ])
    // La nota larga nunca dura más que el patrón y se corta donde termina su clip.
    const offs = rig.events.filter((e) => e.type === 'noteOff' && e.target.pitch === 37)
    expect(offs.map((e) => e.time)).toEqual([2.5, 3, 5].map((t) => expect.closeTo(t, 9)))
  })

  it('songLoop: la posición vuelve al inicio y no se pierde el golpe del tiempo 1', () => {
    const { b, clip } = songProject()
    const c1 = clip(0, PPQ * 8)
    b.project.clips = { [c1.id]: c1 }
    b.project.songLoop = { enabled: true, startTick: PPQ * 2, endTick: PPQ * 4 }
    const rig = createRig(1, b.buffers)
    rig.engine.setProject(b.project)
    rig.engine.play()
    run(rig, 0, 4.2, 0.031)
    // 0–2 s lineal; a partir de ahí se repite el tramo [1 s, 2 s) de la canción.
    const expected = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]
    expect(rig.ons().map((e) => e.time)).toEqual(expected.map((t) => expect.closeTo(t, 9)))
    expect(rig.engine.tickAtTime(1.999)).toBeCloseTo(PPQ * 4 - 0.001 * 1920, 6)
    expect(rig.engine.tickAtTime(2.25)).toBeCloseTo(PPQ * 2.5, 6)
    expect(rig.engine.linearTickAtTime(2.25)).toBeCloseTo(PPQ * 4.5, 6)
    // Las notas que cruzaban la vuelta se sueltan en la vuelta: nada colgado.
    rig.engine.stop()
    const ons = rig.events.filter((e) => e.type === 'noteOn').length
    expect(rig.events.filter((e) => e.type === 'noteOff')).toHaveLength(ons)
  })

  it('arranca desde fromTick', () => {
    const { b, clip } = songProject()
    const c1 = clip(0, PPQ * 8)
    b.project.clips = { [c1.id]: c1 }
    const rig = createRig(1, b.buffers)
    rig.engine.setProject(b.project)
    rig.engine.play({ fromTick: PPQ * 3 })
    run(rig, 0, 1)
    expect(rig.ons().map((e) => [e.pitch, e.time])).toEqual([
      [37, expect.closeTo(0, 9)],
      [36, expect.closeTo(0.5, 9)],
    ])
  })
})

describe('count-in y metrónomo', () => {
  it('durante el count-in la posición es negativa y no suena el secuenciador', () => {
    const { b, drums } = setup(120)
    b.pattern(drums.id, [note(0)], PPQ * 4)
    const rig = createRig(1, b.buffers)
    rig.engine.setProject(b.project)
    const info = rig.engine.play({ countInBars: 1 })
    expect(info).toMatchObject({ startTime: 0, fromTick: 0 })
    expect(info!.musicStartTime).toBeCloseTo(2, 9)
    run(rig, 0, 4.5)
    expect(rig.engine.tickAtTime(0)).toBeCloseTo(-PPQ * 4, 6)
    expect(rig.engine.tickAtTime(2)).toBeCloseTo(0, 6)
    expect(rig.engine.linearTickAtTime(1)).toBeCloseTo(-PPQ * 2, 6)
    expect(rig.ons().map((e) => e.time)).toEqual([2, 4].map((t) => expect.closeTo(t, 9)))
  })

  it('beatsInWindow: tiempos y acentos según el compás, también en negativo', () => {
    const { b } = setup()
    expect(beatsInWindow(b.project, -PPQ * 4, PPQ)).toEqual([
      { tick: -3840, accent: true },
      { tick: -2880, accent: false },
      { tick: -1920, accent: false },
      { tick: -960, accent: false },
      { tick: 0, accent: true },
    ])
    b.project.timeSignature = { numerator: 6, denominator: 8 }
    const beats = beatsInWindow(b.project, 0, PPQ * 3 + 1)
    expect(beats.map((x) => x.tick)).toEqual([0, 480, 960, 1440, 1920, 2400, 2880])
    expect(beats.filter((x) => x.accent).map((x) => x.tick)).toEqual([0, 2880])
  })

  it('rejilla del transporte: gridTimesBetween sigue los cambios de tempo', () => {
    const { b } = setup(120)
    const rig = createRig(1, b.buffers)
    rig.engine.setProject(b.project)
    rig.engine.play()
    rig.engine.advanceTo(1)
    rig.engine.setProject({ ...b.project, bpm: 60 })
    rig.engine.advanceTo(3)
    const grid = rig.engine.gridTimesBetween(0.4, 2.1, PPQ / 2)
    expect(grid.map((g) => g.tick)).toEqual([960, 1440, 1920, 2400, 2880])
    expect(grid.map((g) => g.time)).toEqual(
      [0.5, 0.75, 1, 1.5, 2].map((t) => expect.closeTo(t, 9)),
    )
  })
})

describe('mixer: mute y solo', () => {
  it('mute gana; con algún solo, solo suenan las pistas en solo', () => {
    const { drums } = setup()
    const with_ = (mixer: Partial<typeof drums.mixer>) => ({
      ...drums,
      mixer: { ...drums.mixer, ...mixer },
    })
    expect(trackGain(with_({}), false)).toBe(1)
    expect(trackGain(with_({ volumeDb: -6 }), false)).toBeCloseTo(0.501, 3)
    expect(trackGain(with_({ mute: true }), false)).toBe(0)
    expect(trackGain(with_({}), true)).toBe(0)
    expect(trackGain(with_({ solo: true }), true)).toBe(1)
    expect(trackGain(with_({ solo: true, mute: true }), true)).toBe(0)
  })
})
