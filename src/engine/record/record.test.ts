/**
 * Grabación de punta a punta con MIDI sintético:
 * bytes → InputRouter → LiveSession (note repeat, motor, grabador) → toma → applyTake.
 *
 * Reloj de prueba: audio = performance.now() / 1000. A 120 BPM un compás
 * de 4/4 dura 2 s y son 3840 ticks (1920 ticks por segundo).
 */
import { describe, expect, it } from 'vitest'
import {
  PPQ,
  gridTicks,
  newId,
  type ClipId,
  type ControlDef,
  type ControlId,
  type ControllerProfile,
  type ControllerProfileId,
  type InstrumentEvent,
  type PatternClip,
  type Project,
  type RecordMode,
} from '../../model'
import { fixedClock } from '../../midi/clock'
import { ManualMidiSource, midiBytes } from '../../midi/message'
import { InputRouter } from '../../midi/router'
import { Engine } from '../engine'
import { ProjectBuilder, note, offlineContext } from '../testing'
import { ManualTimer } from '../timer'
import { quantizePattern } from './quantize'
import { LiveSession } from './session'
import { applyTake, type Take } from './take'

const BAR = PPQ * 4
const TPS = 1920 // ticks por segundo a 120 BPM
const DEVICE = 'Pads'

function setup(mode: RecordMode = 'overdub', countInBars = 1) {
  const ctx = offlineContext(0.1)
  const b = new ProjectBuilder(ctx, 120)
  const drums = b.drumRack()
  const second = b.drumRack()
  const unarmed = b.drumRack()
  drums.armed = true
  second.armed = true
  const pattern = b.pattern(drums.id, [note(0, 36), note(960, 37), note(1920, 36)], BAR)
  b.project.recordMode = mode
  b.project.metronome = { ...b.project.metronome, countInBars }

  // Controlador: pad A → drums, pad B → segunda pista, pad C → pista sin armar.
  const pad = (n: number): ControlDef => ({
    id: newId<ControlId>(),
    kind: 'pad',
    label: `Pad ${n}`,
    message: { type: 'note', channel: 9, note: n },
  })
  const [padA, padB, padC] = [pad(51), pad(52), pad(53)]
  const profile: ControllerProfile = {
    id: newId<ControllerProfileId>(),
    deviceName: DEVICE,
    controls: [padA!, padB!, padC!],
    transport: {},
    keysChannel: null,
  }
  b.project.controllers = [
    {
      profileId: profile.id,
      defaultTrackId: drums.id,
      padTargets: {
        [padA!.id]: { trackId: drums.id, pitch: 38 },
        [padB!.id]: { trackId: second.id, pitch: 40 },
        [padC!.id]: { trackId: unarmed.id, pitch: 36 },
      },
    },
  ]

  let now = 0
  const timer = new ManualTimer()
  const engine = new Engine({
    context: ctx,
    buffers: b.buffers,
    timer,
    startDelaySec: 0,
    metronomeOutput: null,
    now: () => now,
  })
  const events: InstrumentEvent[] = []
  engine.onEvent((e) => events.push(e))
  const takes: Take[] = []
  const session = new LiveSession({ engine, onTake: (t) => takes.push(t) })
  const state = { project: b.project as Project }
  session.setProject(state.project)
  const source = new ManualMidiSource()
  const router = new InputRouter({
    clock: fixedClock(0),
    getProject: () => state.project,
    getProfiles: () => [profile],
    getSelectedTrackId: () => drums.id,
    onEvent: (e) => session.input(e),
    onTransport: (action, pressed) => session.transport(action, pressed),
  })
  router.connect(source)

  /** Avanza el reloj hasta `time` con pasadas del scheduler cada 25 ms. */
  const goto = (time: number): void => {
    while (now < time) {
      now = Math.min(time, now + 0.025)
      timer.tick()
    }
  }
  /** Mensaje MIDI en el segundo `time` (el reloj avanza hasta ahí primero). */
  const midi = (time: number, data: number[]): void => {
    goto(time)
    source.send({ data, timeStamp: time * 1000, deviceName: DEVICE })
  }
  /** Golpe corto del pad (nota MIDI `n`) en el segundo `time`. */
  const hit = (time: number, n = 51, lengthSec = 0.05): void => {
    midi(time, midiBytes.noteOn(9, n, 100))
    midi(time + lengthSec, midiBytes.noteOff(9, n))
  }
  /** Lo que haría la UI al recibir la toma: aplicarla como un paso de deshacer. */
  const commit = (): Project => {
    state.project = applyTake(state.project, takes.at(-1)!)
    session.setProject(state.project)
    return state.project
  }
  const notesOf = (project: Project, patternId = pattern.id) =>
    project.patterns[patternId]!.notes.map((n) => [n.tick, n.pitch, n.durationTicks])

  return { b, drums, second, unarmed, pattern, engine, session, events, takes, state, goto, midi, hit, commit, notesOf }
}

describe('grabación: overdub en loop', () => {
  it('convierte a ticks y conserva el timing real en la nota y en `recorded`', () => {
    const s = setup()
    s.session.toggleRecord() // count-in de 1 compás: la música empieza en t = 2 s
    expect(s.session.isRecording).toBe(true)
    s.hit(2.26) // 0.26 s → tick 499.2
    s.goto(3)
    s.session.stop()
    expect(s.takes).toHaveLength(1)
    const project = s.commit()
    const recorded = project.patterns[s.pattern.id]!.notes.at(-1)!
    expect(recorded).toMatchObject({
      tick: 499,
      durationTicks: 96,
      pitch: 38,
      velocity: 100,
      recorded: { tick: 499, durationTicks: 96 },
    })
    // Overdub: lo que había sigue ahí.
    expect(project.patterns[s.pattern.id]!.notes).toHaveLength(4)
  })

  it('compensa la latencia configurada', () => {
    const s = setup()
    s.session.latencySec = 0.02
    s.session.toggleRecord()
    s.hit(2.52)
    s.goto(3)
    s.session.stop()
    expect(s.notesOf(s.commit()).at(-1)).toEqual([960, 38, 96])
  })

  it('una nota que cruza el final del loop conserva su inicio y su duración real', () => {
    const s = setup()
    s.session.toggleRecord()
    // Pulsa 100 ticks antes del final del compás y suelta 300 ticks después de la vuelta.
    s.midi(2 + (BAR - 100) / TPS, midiBytes.noteOn(9, 51, 100))
    s.midi(2 + (BAR + 300) / TPS, midiBytes.noteOff(9, 51))
    s.goto(6.5)
    s.session.stop()
    const project = s.commit()
    expect(s.notesOf(project).at(-1)).toEqual([BAR - 100, 38, 400])

    // Y el secuenciador la reproduce así: empieza antes del final y termina en la vuelta siguiente.
    s.events.length = 0
    const t0 = s.engine.play()!.startTime
    s.engine.advanceTo(t0 + 4.5)
    const times = (type: string) =>
      s.events.flatMap((e) => (e.type === type && e.type !== 'sustain' && e.target.pitch === 38 ? [e.time - t0] : []))
    expect(times('noteOn')).toEqual([
      expect.closeTo((BAR - 100) / TPS, 9),
      expect.closeTo((2 * BAR - 100) / TPS, 9),
    ])
    expect(times('noteOff')[0]).toBeCloseTo((BAR + 300) / TPS, 9)
  })

  it('lo grabado suena en la siguiente vuelta sin esperar a parar, y el proyecto de la UI no se toca', () => {
    const s = setup()
    const before = s.state.project
    s.session.toggleRecord()
    s.hit(2.5)
    s.events.length = 0
    s.goto(5)
    const replayed = s.events.filter(
      (e) => e.type === 'noteOn' && e.source === 'sequencer' && e.target.pitch === 38,
    )
    expect(replayed.map((e) => e.time)).toEqual([expect.closeTo(4.5, 9)])
    expect(s.state.project).toBe(before)
    expect(before.patterns[s.pattern.id]!.notes).toHaveLength(3)
  })

  it('varias vueltas en una toma: todo se acumula', () => {
    const s = setup()
    s.session.toggleRecord()
    s.hit(2.25)
    s.hit(4.75)
    s.hit(6.5)
    s.goto(7)
    s.session.stop()
    const ticks = s.notesOf(s.commit()).slice(3).map((n) => n[0])
    expect(ticks).toEqual([480, 1440, 960])
  })
})

describe('grabación: golpes adelantados y count-in', () => {
  it('un golpe un pelo antes del tiempo 1 se conserva al final del loop; lo anterior del count-in se descarta', () => {
    const s = setup()
    s.session.toggleRecord()
    s.hit(0.8) // calentando en pleno count-in: fuera
    s.hit(2 - 30 / TPS) // 30 ticks antes del tiempo 1
    s.goto(3)
    s.session.stop()
    const project = s.commit()
    expect(s.takes[0]!.notes.map((n) => n.tick)).toEqual([-30])
    // En el loop cae 30 ticks antes del final: suena igual que como se tocó.
    expect(s.notesOf(project).at(-1)).toEqual([BAR - 30, 38, 96])
    // Al cuantizar da la vuelta al tiempo 1, y el original no se pierde.
    const quantized = quantizePattern(project, s.pattern.id, { gridTicks: gridTicks(16) })
    expect(quantized.patterns[s.pattern.id]!.notes.at(-1)).toMatchObject({
      tick: 0,
      recorded: { tick: BAR - 30, durationTicks: 96 },
    })
  })

  it('en grabación lineal el golpe adelantado se pega al inicio del clip', () => {
    const s = setup('linear')
    s.session.toggleRecord()
    s.hit(2 - 30 / TPS)
    s.goto(3)
    s.session.stop()
    const project = s.commit()
    const clip = Object.values(project.clips)[0] as PatternClip
    expect(clip).toMatchObject({ startTick: 0, lengthTicks: BAR, trackId: s.drums.id })
    expect(project.patterns[clip.patternId]!.notes.map((n) => n.tick)).toEqual([0])
  })

  it('notas aún pulsadas al parar se cierran en el punto de parada', () => {
    const s = setup()
    s.session.toggleRecord()
    s.midi(2.5, midiBytes.noteOn(9, 51, 100))
    s.goto(3)
    s.session.stop()
    expect(s.notesOf(s.commit()).at(-1)).toEqual([960, 38, 960])
    expect(s.takes[0]!.lengthTicks).toBe(1920)
  })
})

describe('grabación: replace', () => {
  it('sustituye lo anterior de las pistas armadas; las vueltas de la misma toma se acumulan', () => {
    const s = setup('replace')
    s.session.toggleRecord()
    s.hit(2.25)
    s.hit(4.75) // segunda vuelta
    s.goto(6.6) // tercera vuelta sin tocar: no borra lo recién grabado
    s.session.stop()
    expect(s.notesOf(s.commit())).toEqual([
      [480, 38, 96],
      [1440, 38, 96],
    ])
  })

  it('lo anterior deja de sonar desde que empieza la grabación', () => {
    const s = setup('replace')
    s.session.toggleRecord()
    s.events.length = 0
    s.goto(5.9)
    expect(s.events.filter((e) => e.type === 'noteOn')).toHaveLength(0)
  })

  it('una toma más corta que el loop solo borra la zona recorrida', () => {
    const s = setup('replace', 0)
    s.session.toggleRecord()
    s.hit(0.25)
    s.goto(0.75) // recorre [0, 1440): cubre las notas en 0 y 960, no la de 1920
    s.session.stop()
    expect(s.notesOf(s.commit())).toEqual([
      [1920, 36, 120],
      [480, 38, 96],
    ])
  })

  it('una pista armada en la que no se tocó también se limpia (es lo que significa reemplazar)', () => {
    const s = setup('replace')
    const other = s.b.pattern(s.second.id, [note(0, 40)], BAR)
    s.session.setProject({ ...s.state.project })
    s.session.toggleRecord()
    s.hit(2.25)
    s.goto(4.1)
    s.session.stop()
    expect(s.notesOf(s.commit(), other.id)).toEqual([])
  })
})

describe('grabación: varias pistas y lineal', () => {
  it('una toma escribe en todas las pistas armadas que toca el controlador, y solo en esas', () => {
    const s = setup()
    s.session.toggleRecord()
    s.hit(2.25, 51)
    s.hit(2.5, 52)
    s.hit(2.75, 53) // pista sin armar: suena pero no se graba
    s.goto(4.5)
    s.session.stop()
    const take = s.takes[0]!
    expect(take.notes.map((n) => [n.trackId, n.pitch, n.tick])).toEqual([
      [s.drums.id, 38, 480],
      [s.second.id, 40, 960],
    ])
    const before = s.state.project
    const project = s.commit()
    // La segunda pista no tenía patrón: se crea con el largo del loop que sonaba.
    const created = project.patterns[project.tracks[s.second.id]!.activePatternId!]!
    expect(created).toMatchObject({ trackId: s.second.id, lengthTicks: BAR })
    expect(created.notes.map((n) => [n.tick, n.pitch])).toEqual([[960, 40]])
    expect(project.tracks[s.unarmed.id]!.activePatternId).toBeNull()
    // Un solo paso: función pura, el proyecto anterior queda intacto y repetirla da lo mismo.
    expect(before.patterns[s.pattern.id]!.notes).toHaveLength(3)
    expect(applyTake(before, take)).toEqual(project)
    // El evento de la pista sin armar sí llegó al motor.
    expect(s.events.some((e) => e.type === 'noteOn' && e.target.trackId === s.unarmed.id)).toBe(true)
  })

  it('linear: crea un Pattern + PatternClip por pista armada tocada, de compás a compás', () => {
    const s = setup('linear', 0)
    s.state.project = { ...s.state.project, transportMode: 'song' }
    s.session.setProject(s.state.project)
    s.session.toggleRecord(BAR * 2) // graba desde el compás 3
    s.hit(0.25, 51)
    s.hit(2.5, 52)
    s.hit(2.75, 51)
    s.goto(3.1) // 5952 ticks grabados: el clip se redondea a 2 compases
    s.session.stop()
    const project = s.commit()
    const clips = Object.values(project.clips) as PatternClip[]
    expect(clips).toHaveLength(2)
    for (const clip of clips) {
      expect(clip).toMatchObject({ kind: 'pattern', startTick: BAR * 2, lengthTicks: BAR * 2, offsetTicks: 0 })
      expect(project.patterns[clip.patternId]).toMatchObject({ trackId: clip.trackId, lengthTicks: BAR * 2 })
    }
    const notesFor = (trackId: string) =>
      project.patterns[clips.find((c) => c.trackId === trackId)!.patternId]!.notes.map((n) => n.tick)
    expect(notesFor(s.drums.id)).toEqual([480, 5280])
    expect(notesFor(s.second.id)).toEqual([4800])
    // Los patrones que ya existían no se tocan.
    expect(project.patterns[s.pattern.id]).toBe(s.state.project.patterns[s.pattern.id])
  })

  it('modo canción + overdub: las notas caen en el patrón del clip que hay debajo', () => {
    const s = setup('overdub', 0)
    const clip: PatternClip = {
      id: newId<ClipId>(),
      kind: 'pattern',
      trackId: s.drums.id,
      patternId: s.pattern.id,
      startTick: BAR,
      lengthTicks: BAR * 2,
      offsetTicks: 960,
    }
    s.state.project = { ...s.state.project, transportMode: 'song', clips: { [clip.id]: clip } }
    s.session.setProject(s.state.project)
    s.session.toggleRecord()
    s.hit(0.5) // tick 960: no hay clip → clip nuevo
    s.hit(2.25) // tick 4320 = 480 dentro del clip; + offset 960 → 1440 del patrón
    s.hit(5.75) // tick 11040 = 7200 dentro del clip; + 960 → 8160 mod 3840 = 480
    s.goto(6.5)
    s.session.stop()
    const project = s.commit()
    expect(s.notesOf(project).slice(3)).toEqual([
      [1440, 38, 96],
      [480, 38, 96],
    ])
    const created = Object.values(project.clips).find((c) => c.id !== clip.id) as PatternClip
    expect(created).toMatchObject({ startTick: 0, lengthTicks: BAR, trackId: s.drums.id })
    expect(project.patterns[created.patternId]!.notes.map((n) => n.tick)).toEqual([960])
  })

  it('punch-in con el transporte en marcha y punch-out sin parar', () => {
    const s = setup('overdub', 0)
    s.session.play()
    s.goto(1)
    s.hit(1.1) // antes de grabar: no entra
    s.goto(1.5)
    s.session.toggleRecord()
    s.hit(1.75)
    s.goto(2.5)
    s.session.toggleRecord()
    expect(s.engine.isPlaying).toBe(true)
    s.hit(2.75) // después del punch-out: no entra
    expect(s.takes).toHaveLength(1)
    expect(s.takes[0]).toMatchObject({ startTick: 2880, lengthTicks: 1920 })
    expect(s.takes[0]!.notes.map((n) => n.tick)).toEqual([3360])
  })

  it('pedal de sustain: la nota grabada dura hasta que se levanta el pedal', () => {
    const s = setup('overdub', 0)
    s.session.toggleRecord()
    const pedal = (time: number, on: boolean) => {
      s.goto(time)
      s.session.input({ type: 'sustain', time, trackId: s.drums.id, on, source: 'live' })
    }
    pedal(0.1, true)
    s.hit(0.25)
    pedal(0.75, false)
    s.goto(1)
    s.session.stop()
    expect(s.takes[0]!.notes.map((n) => [n.tick, n.durationTicks])).toEqual([[480, 960]])
  })
})
