import { useCallback } from 'react'
import { connectMidi, startOrStopRecording, togglePlay, useLive } from '../audio/engineHost'
import { PPQ, gridTicks, ticksPerBar } from '../model'
import { useProject } from '../state/store'
import { setTransportMode } from '../state/arrangeActions'
import { setBpm, setCountIn, setMetronome, setNoteRepeat, setRecordMode } from '../state/trackActions'
import { NumberField } from './NumberField'
import { usePlayhead, usePlaying } from './transport'

const REPEAT_RATES = [
  { label: '1/4', ticks: gridTicks(4) },
  { label: '1/8', ticks: gridTicks(8) },
  { label: '1/8T', ticks: gridTicks(8, true) },
  { label: '1/16', ticks: gridTicks(16) },
  { label: '1/16T', ticks: gridTicks(16, true) },
  { label: '1/32', ticks: gridTicks(32) },
]

function MidiIndicator({ onOpen }: { onOpen: () => void }) {
  const status = useLive((s) => s.midiStatus)
  const devices = useLive((s) => s.devices)
  const blink = useLive((s) => s.midiBlink)
  const label =
    status === 'on'
      ? devices.length
        ? devices.length === 1
          ? devices[0]
          : `${devices.length} equipos`
        : 'Sin equipos'
      : status === 'connecting'
        ? 'Conectando…'
        : status === 'unsupported'
          ? 'Sin Web MIDI'
          : status === 'error'
            ? 'Error MIDI'
            : 'Conectar MIDI'
  return (
    <button
      className="midi"
      title="Controlador MIDI: conectar, aprender pads y botones"
      onClick={() => {
        if (status === 'off' || status === 'error') void connectMidi()
        onOpen()
      }}
    >
      <span className={`led ${status === 'on' ? 'on' : ''} ${blink ? 'blink' : ''}`} />
      {label}
    </button>
  )
}

export function Transport({ onOpenController }: { onOpenController: () => void }) {
  const playing = usePlaying()
  const recording = useLive((s) => s.recording)
  const bpm = useProject((p) => p.bpm)
  const metronome = useProject((p) => p.metronome)
  const recordMode = useProject((p) => p.recordMode)
  const mode = useProject((p) => p.transportMode)
  const noteRepeat = useProject((p) => p.noteRepeat)
  const ts = useProject((p) => p.timeSignature)
  const barTicks = ticksPerBar(ts)
  const beatTicks = (PPQ * 4) / ts.denominator
  const position = usePlayhead(
    useCallback(
      (tick: number, countingIn: boolean) => {
        if (countingIn) return `-${Math.ceil(-tick / beatTicks)}`
        const t = Math.max(0, tick)
        return `${Math.floor(t / barTicks) + 1}.${Math.floor((t % barTicks) / beatTicks) + 1}`
      },
      [barTicks, beatTicks],
    ),
  )

  return (
    <div className="transport">
      <button className={`play ${playing ? 'active' : ''}`} title="Play / Stop (Espacio)" onClick={togglePlay}>
        {playing ? '■' : '▶'}
      </button>
      <button
        className={`rec ${recording ? 'active' : ''}`}
        title="Grabar (Shift+Espacio). Si no hay pistas armadas, arma la seleccionada."
        onClick={startOrStopRecording}
      >
        ●
      </button>
      <select className="mini" value={mode} title="Patrón: cada pista loopea su patrón · Canción: suena el arreglo" onChange={(e) => setTransportMode(e.target.value as 'pattern' | 'song')}>
        <option value="pattern">Patrón</option>
        <option value="song">Canción</option>
      </select>
      <span className={`position ${position?.startsWith('-') ? 'count' : ''}`}>{position ?? '1.1'}</span>
      <NumberField label="BPM" value={bpm} min={20} max={300} step={0.5} width={64} onCommit={setBpm} />
      <label className="check" title="Metrónomo">
        <input type="checkbox" checked={metronome.enabled} onChange={(e) => setMetronome(e.target.checked)} />
        Clic
      </label>
      <label className="field" title="Compases de cuenta previa al grabar">
        <span>Cuenta</span>
        <select value={metronome.countInBars} onChange={(e) => setCountIn(Number(e.target.value))}>
          {[0, 1, 2].map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'no' : `${n} comp.`}
            </option>
          ))}
        </select>
      </label>
      <label className="field" title="Overdub: suma a lo que hay. Reemplazo: borra lo anterior de las pistas armadas por donde pasa.">
        <span>Grabar</span>
        <select value={recordMode} onChange={(e) => setRecordMode(e.target.value as 'overdub' | 'replace' | 'linear')}>
          <option value="overdub">overdub</option>
          <option value="replace">reemplazo</option>
          {mode === 'song' && <option value="linear">lineal (clips nuevos)</option>}
        </select>
      </label>
      <label className="check" title="Note repeat: mantener un pad lo repite en la rejilla">
        <input type="checkbox" checked={noteRepeat.enabled} onChange={(e) => setNoteRepeat({ enabled: e.target.checked })} />
        Repeat
      </label>
      <select
        className="mini"
        value={noteRepeat.intervalTicks}
        title="Velocidad del note repeat"
        onChange={(e) => setNoteRepeat({ intervalTicks: Number(e.target.value) })}
      >
        {REPEAT_RATES.map((r) => (
          <option key={r.label} value={r.ticks}>
            {r.label}
          </option>
        ))}
      </select>
      <MidiIndicator onOpen={onOpenController} />
    </div>
  )
}
