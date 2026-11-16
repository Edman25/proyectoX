import { describe, expect, it } from 'vitest'
import {
  createDrumRack,
  createEmptyProject,
  newId,
  type ControlDef,
  type ControlId,
  type ControlKind,
  type ControllerProfile,
  type ControllerProfileId,
  type InstrumentEvent,
  type MidiMessageMatch,
  type Project,
  type TrackId,
  type TransportAction,
} from '../model'
import { fixedClock, outputTimestampClock } from './clock'
import { addControl, learnNext } from './learn'
import { ManualMidiSource, midiBytes, parseMidi } from './message'
import { InputRouter, type ControlChange } from './router'

const DEVICE = 'Controlador de prueba'

function control(kind: ControlKind, message: MidiMessageMatch): ControlDef {
  return { id: newId<ControlId>(), kind, label: kind, message }
}

function setup() {
  const drums = createDrumRack('Drums', 16)
  const other = { ...createDrumRack('Otra', 16), id: newId<TrackId>(), baseNote: 60 }
  // Un controlador que manda sus pads en el canal 10 con notas "raras".
  const pads = [51, 47, 44].map((note) => control('pad', { type: 'note', channel: 9, note }))
  const recButton = control('button', { type: 'note', channel: 9, note: 20 })
  const ccButton = control('button', { type: 'cc', channel: 9, cc: 115 })
  const knob = control('knob', { type: 'cc', channel: 9, cc: 7 })
  const ccPad = control('pad', { type: 'cc', channel: 9, cc: 30 })
  const profile: ControllerProfile = {
    id: newId<ControllerProfileId>(),
    deviceName: DEVICE,
    controls: [pads[0]!, recButton, pads[1]!, knob, pads[2]!, ccButton, ccPad],
    transport: { record: recButton.id, noteRepeat: ccButton.id },
    keysChannel: 0,
  }
  const state = {
    project: {
      ...createEmptyProject(),
      tracks: { [drums.id]: drums, [other.id]: other },
      trackOrder: [drums.id, other.id],
      controllers: [
        {
          profileId: profile.id,
          padTargets: { [pads[1]!.id]: { trackId: other.id, pitch: 72 } },
          defaultTrackId: null,
        },
      ],
    } as Project,
    selected: drums.id as TrackId | null,
  }
  const events: InstrumentEvent[] = []
  const actions: [TransportAction, boolean, number][] = []
  const changes: ControlChange[] = []
  const source = new ManualMidiSource()
  const router = new InputRouter({
    clock: fixedClock(10),
    getProject: () => state.project,
    getProfiles: () => [profile],
    getSelectedTrackId: () => state.selected,
    onEvent: (e) => events.push(e),
    onTransport: (action, pressed, time) => actions.push([action, pressed, time]),
    onControl: (c) => changes.push(c),
  })
  router.connect(source)
  const send = (data: number[], timeStamp = 0, deviceName = DEVICE) =>
    source.send({ data, timeStamp, deviceName })
  return { drums, other, pads, profile, state, events, actions, changes, send, router, source, knob }
}

describe('parseMidi', () => {
  it('note on, note off, CC y canal', () => {
    expect(parseMidi([0x93, 60, 100])).toEqual({ kind: 'noteOn', channel: 3, note: 60, velocity: 100 })
    expect(parseMidi([0x83, 60, 64])).toEqual({ kind: 'noteOff', channel: 3, note: 60 })
    expect(parseMidi([0xbf, 64, 127])).toEqual({ kind: 'cc', channel: 15, cc: 64, value: 127 })
  })

  it('note on con velocity 0 es note off', () => {
    expect(parseMidi(new Uint8Array([0x90, 60, 0]))).toEqual({ kind: 'noteOff', channel: 0, note: 60 })
  })

  it('ignora lo que no usa (clock, pitch bend, mensajes cortos)', () => {
    expect(parseMidi([0xf8])).toBeNull()
    expect(parseMidi([0xe0, 0, 64])).toBeNull()
    expect(parseMidi([0x90, 60])).toBeNull()
  })
})

describe('InputRouter', () => {
  it('pad sin destino → pista por defecto, base + índice entre los controles tipo pad', () => {
    const { drums, events, send } = setup()
    send(midiBytes.noteOn(9, 51, 90), 500)
    send(midiBytes.noteOn(9, 44, 80), 600)
    expect(events).toEqual([
      {
        type: 'noteOn',
        time: 10.5,
        target: { trackId: drums.id, pitch: drums.baseNote },
        velocity: 90,
        source: 'live',
      },
      // Tercer pad del perfil (los botones y perillas intercalados no cuentan).
      {
        type: 'noteOn',
        time: 10.6,
        target: { trackId: drums.id, pitch: drums.baseNote + 2 },
        velocity: 80,
        source: 'live',
      },
    ])
  })

  it('pad con destino en el proyecto → ese destino, aunque sea otra pista', () => {
    const { other, events, send } = setup()
    send(midiBytes.noteOn(9, 47))
    expect(events[0]).toMatchObject({ type: 'noteOn', target: { trackId: other.id, pitch: 72 } })
  })

  it('el note-off va al mismo destino que su note-on aunque cambie la pista seleccionada', () => {
    const { drums, other, state, events, send } = setup()
    send(midiBytes.noteOn(9, 51))
    state.selected = other.id
    send(midiBytes.noteOff(9, 51), 100)
    send(midiBytes.noteOn(9, 51), 200)
    expect(events.map((e) => (e.type === 'sustain' ? null : [e.type, e.target.trackId, e.target.pitch]))).toEqual([
      ['noteOn', drums.id, 36],
      ['noteOff', drums.id, 36],
      ['noteOn', other.id, 60],
    ])
  })

  it('teclas: canal keysChannel → altura = nota MIDI; otros canales se ignoran', () => {
    const { drums, events, send } = setup()
    send(midiBytes.noteOn(0, 64, 70))
    send(midiBytes.noteOff(0, 64))
    send(midiBytes.noteOn(5, 64, 70))
    // Una nota del canal de pads que no es un control aprendido tampoco es una tecla.
    send(midiBytes.noteOn(9, 99, 70))
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'noteOn', target: { trackId: drums.id, pitch: 64 }, velocity: 70 })
    expect(events[1]).toMatchObject({ type: 'noteOff', target: { trackId: drums.id, pitch: 64 } })
  })

  it('CC64 → sustain en la pista por defecto', () => {
    const { drums, events, send } = setup()
    send(midiBytes.cc(0, 64, 127))
    send(midiBytes.cc(0, 64, 0))
    send(midiBytes.cc(0, 1, 50)) // otra rueda: nada
    expect(events).toEqual([
      { type: 'sustain', time: 10, trackId: drums.id, on: true, source: 'live' },
      { type: 'sustain', time: 10, trackId: drums.id, on: false, source: 'live' },
    ])
  })

  it('defaultTrackId del proyecto manda sobre la pista seleccionada', () => {
    const { other, state, events, send } = setup()
    state.project = {
      ...state.project,
      controllers: [{ ...state.project.controllers[0]!, defaultTrackId: other.id }],
    }
    send(midiBytes.noteOn(0, 64))
    send(midiBytes.noteOn(9, 51))
    expect(events.map((e) => e.type !== 'sustain' && [e.target.trackId, e.target.pitch])).toEqual([
      [other.id, 64],
      [other.id, 60],
    ])
  })

  it('botones → acciones de transporte (nota o CC), con pulsar y soltar', () => {
    const { events, actions, send } = setup()
    send(midiBytes.noteOn(9, 20), 1000)
    send(midiBytes.noteOff(9, 20), 1100)
    send(midiBytes.cc(9, 115, 127), 1200)
    send(midiBytes.cc(9, 115, 0), 1300)
    expect(events).toHaveLength(0)
    expect(actions).toEqual([
      ['record', true, 11],
      ['record', false, 11.1],
      ['noteRepeat', true, 11.2],
      ['noteRepeat', false, 11.3],
    ])
  })

  it('perillas → onControl con valor 0–1; pads por CC → notas', () => {
    const { drums, events, changes, send, knob } = setup()
    send(midiBytes.cc(9, 7, 127))
    expect(changes).toEqual([expect.objectContaining({ controlId: knob.id, value: 1 })])
    send(midiBytes.cc(9, 30, 100))
    send(midiBytes.cc(9, 30, 110)) // sigue pulsado: no re-dispara
    send(midiBytes.cc(9, 30, 0))
    expect(events).toMatchObject([
      { type: 'noteOn', target: { trackId: drums.id, pitch: drums.baseNote + 3 }, velocity: 100 },
      { type: 'noteOff', target: { trackId: drums.id, pitch: drums.baseNote + 3 } },
    ])
  })

  it('un equipo sin perfil se trata como teclado en cualquier canal', () => {
    const { drums, events, send } = setup()
    send(midiBytes.noteOn(7, 51, 99), 0, 'Otro equipo')
    expect(events[0]).toMatchObject({ target: { trackId: drums.id, pitch: 51 }, velocity: 99 })
  })

  it('entrada local (pantalla / teclado) por la misma ruta', () => {
    const { drums, events, router } = setup()
    const target = { trackId: drums.id, pitch: 40 }
    router.localNoteOn(target, 127, 250)
    router.localNoteOff(target, 300)
    expect(events).toEqual([
      { type: 'noteOn', time: 10.25, target, velocity: 127, source: 'live' },
      { type: 'noteOff', time: 10.3, target, source: 'live' },
    ])
  })
})

describe('reloj performance.now() → audio', () => {
  it('usa el par de getOutputTimestamp', () => {
    const clock = outputTimestampClock({
      currentTime: 99,
      getOutputTimestamp: () => ({ contextTime: 5, performanceTime: 2000 }),
    })
    expect(clock.toAudioTime(2000)).toBe(5)
    expect(clock.toAudioTime(1900)).toBeCloseTo(4.9, 9)
  })

  it('sin timestamp de salida cae a currentTime − outputLatency', () => {
    const clock = outputTimestampClock(
      {
        currentTime: 8,
        outputLatency: 0.02,
        getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
      },
      () => 3000,
    )
    expect(clock.toAudioTime(3000)).toBeCloseTo(7.98, 9)
    expect(clock.toAudioTime(2950)).toBeCloseTo(7.93, 9)
  })
})

describe('learn', () => {
  it('captura el siguiente note-on como ControlDef, sin asumir nota ni canal', async () => {
    const source = new ManualMidiSource()
    const learned = learnNext(source, { kind: 'pad', label: 'Kick' })
    source.send({ data: midiBytes.noteOff(4, 10), timeStamp: 0, deviceName: 'X' }) // no cuenta
    source.send({ data: midiBytes.noteOn(4, 77, 100), timeStamp: 1, deviceName: 'X' })
    const { control: c, deviceName } = await learned
    expect(deviceName).toBe('X')
    expect(c).toMatchObject({ kind: 'pad', label: 'Kick', message: { type: 'note', channel: 4, note: 77 } })
    // Ya no escucha.
    source.send({ data: midiBytes.noteOn(4, 78, 100), timeStamp: 2, deviceName: 'X' })
  })

  it('perillas: captura el CC; botones por CC: ignora el soltar', async () => {
    const source = new ManualMidiSource()
    const knob = learnNext(source, { kind: 'knob' })
    source.send({ data: midiBytes.cc(2, 21, 0), timeStamp: 0, deviceName: 'X' })
    expect((await knob).control.message).toEqual({ type: 'cc', channel: 2, cc: 21 })
    const button = learnNext(source, { kind: 'button' })
    source.send({ data: midiBytes.cc(2, 40, 0), timeStamp: 0, deviceName: 'X' })
    source.send({ data: midiBytes.cc(2, 41, 127), timeStamp: 0, deviceName: 'X' })
    expect((await button).control.message).toEqual({ type: 'cc', channel: 2, cc: 41 })
  })

  it('se puede cancelar', async () => {
    const source = new ManualMidiSource()
    const abort = new AbortController()
    const learned = learnNext(source, { kind: 'pad', signal: abort.signal })
    abort.abort()
    await expect(learned).rejects.toThrow()
  })

  it('addControl: re-aprender el mismo mensaje sustituye sin perder el id', () => {
    const { profile, pads } = setup()
    const again = control('pad', { type: 'note', channel: 9, note: 47 })
    const updated = addControl(profile, { ...again, label: 'Snare' })
    expect(updated.controls).toHaveLength(profile.controls.length)
    expect(updated.controls[2]).toMatchObject({ id: pads[1]!.id, label: 'Snare' })
    const added = addControl(profile, control('pad', { type: 'note', channel: 9, note: 1 }))
    expect(added.controls).toHaveLength(profile.controls.length + 1)
    expect(profile.controls).toHaveLength(7)
  })
})
