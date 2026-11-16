/**
 * Note repeat sobre el motor real. 120 BPM: una semicorchea = 240 ticks = 0.125 s.
 */
import { describe, expect, it } from 'vitest'
import { PPQ, gridTicks, type InstrumentEvent, type Project } from '../../model'
import { Engine } from '../engine'
import { ProjectBuilder, offlineContext } from '../testing'
import { ManualTimer } from '../timer'
import { LiveSession } from './session'
import type { Take } from './take'

function setup(intervalTicks = gridTicks(16)) {
  const ctx = offlineContext(0.1)
  const b = new ProjectBuilder(ctx, 120)
  const drums = b.drumRack()
  drums.armed = true
  b.pattern(drums.id, [], PPQ * 4)
  b.project.noteRepeat = { enabled: true, intervalTicks }
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
  const target = { trackId: drums.id, pitch: 36 }
  const goto = (time: number): void => {
    while (now < time) {
      now = Math.min(time, now + 0.025)
      // En vivo el temporizador solo corre con el transporte en marcha; el
      // note repeat con el transporte parado lo empuja la sesión.
      if (timer.running) timer.tick()
      else session.repeater.pump(now)
    }
  }
  const press = (time: number, velocity = 90): void => {
    goto(time)
    session.input({ type: 'noteOn', time, target, velocity, source: 'live' })
  }
  const release = (time: number): void => {
    goto(time)
    session.input({ type: 'noteOff', time, target, source: 'live' })
  }
  const ons = () => events.flatMap((e) => (e.type === 'noteOn' ? [e] : []))
  return { b, drums, engine, session, events, takes, state, goto, press, release, ons }
}

describe('note repeat', () => {
  it('un pad mantenido se repite sobre la rejilla del transporte con la velocity del golpe', () => {
    const s = setup()
    s.session.play()
    s.press(0.3, 77) // entre dos puntos de la rejilla (0.25 y 0.375)
    s.release(0.8)
    s.goto(1.2)
    const hits = s.ons()
    expect(hits.map((e) => e.time)).toEqual(
      [0.375, 0.5, 0.625, 0.75].map((t) => expect.closeTo(t, 9)),
    )
    expect(hits.every((e) => e.velocity === 77 && e.source === 'live')).toBe(true)
    // Cada repetición cierra la anterior, y al soltar se cierra la última.
    const offs = s.events.filter((e) => e.type === 'noteOff').map((e) => e.time)
    expect(offs).toEqual([0.5, 0.625, 0.75, 0.8].map((t) => expect.closeTo(t, 9)))
  })

  it('pulsar un pelo tarde sobre un punto de la rejilla todavía cuenta para ese punto', () => {
    const s = setup()
    s.session.play()
    s.press(0.26) // 10 ms después del punto 0.25
    s.release(0.4)
    expect(s.ons().map((e) => e.time)).toEqual([0.25, 0.375].map((t) => expect.closeTo(t, 9)))
  })

  it('otros intervalos (tresillos) y cambio de BPM: sigue pegado a la rejilla', () => {
    const s = setup(gridTicks(8, true)) // 320 ticks
    s.session.play()
    s.goto(0.5)
    s.session.setProject({ ...s.state.project, bpm: 60 })
    s.press(0.52)
    s.release(2)
    const ticks = s.ons().map((e) => s.engine.tickAtTime(e.time)!)
    expect(ticks.length).toBeGreaterThan(3)
    ticks.forEach((tick, i) => {
      expect(tick / 320).toBeCloseTo(Math.round(tick / 320), 6)
      if (i > 0) expect(tick - ticks[i - 1]!).toBeCloseTo(320, 6)
    })
  })

  it('las repeticiones se graban, exactas en la rejilla aunque haya latencia configurada', () => {
    const s = setup()
    s.session.latencySec = 0.02
    s.b.project.metronome.countInBars = 0
    s.session.toggleRecord()
    s.press(0.3)
    s.release(0.7)
    s.goto(1)
    s.session.stop()
    const take = s.takes[0]!
    expect(take.notes.map((n) => n.tick)).toEqual([720, 960, 1200])
    expect(take.notes.map((n) => n.velocity)).toEqual([90, 90, 90])
    expect(take.notes.slice(0, 2).map((n) => n.durationTicks)).toEqual([240, 240])
  })

  it('desactivado, la nota pasa tal cual', () => {
    const s = setup()
    s.session.setProject({ ...s.state.project, noteRepeat: { enabled: false, intervalTicks: 240 } })
    s.session.play()
    s.press(0.3)
    s.release(0.8)
    s.goto(1)
    expect(s.ons().map((e) => e.time)).toEqual([0.3])
  })

  it('botón de note repeat mantenido (momentáneo) aunque el ajuste del proyecto esté apagado', () => {
    const s = setup()
    s.session.setProject({ ...s.state.project, noteRepeat: { enabled: false, intervalTicks: 240 } })
    s.session.play()
    s.session.transport('noteRepeat', true)
    s.press(0.3)
    s.goto(0.55)
    s.session.transport('noteRepeat', false) // al soltar el botón el pad deja de repetirse
    s.goto(1)
    expect(s.ons().map((e) => e.time)).toEqual([0.375, 0.5].map((t) => expect.closeTo(t, 9)))
    const offs = s.events.filter((e) => e.type === 'noteOff')
    expect(offs).toHaveLength(2)
  })

  it('con el transporte parado: suena al pulsar y se repite desde ahí al BPM del proyecto', () => {
    const s = setup()
    s.press(1.03)
    s.release(1.45)
    s.goto(2)
    expect(s.ons().map((e) => e.time)).toEqual(
      [1.03, 1.155, 1.28, 1.405].map((t) => expect.closeTo(t, 9)),
    )
  })
})
