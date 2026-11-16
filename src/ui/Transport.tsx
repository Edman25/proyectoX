import { useCallback } from 'react'
import { togglePlay } from '../audio/engineHost'
import { PPQ, ticksPerBar } from '../model'
import { useProject } from '../state/store'
import { setBpm, setMetronome } from '../state/trackActions'
import { NumberField } from './NumberField'
import { usePlayhead, usePlaying } from './transport'

export function Transport() {
  const playing = usePlaying()
  const bpm = useProject((p) => p.bpm)
  const metronome = useProject((p) => p.metronome.enabled)
  const ts = useProject((p) => p.timeSignature)
  const barTicks = ticksPerBar(ts)
  const beatTicks = (PPQ * 4) / ts.denominator
  const position = usePlayhead(
    useCallback(
      (tick: number) => {
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
      <span className="position">{position ?? '1.1'}</span>
      <NumberField label="BPM" value={bpm} min={20} max={300} step={0.5} width={64} onCommit={setBpm} />
      <label className="check" title="Metrónomo">
        <input type="checkbox" checked={metronome} onChange={(e) => setMetronome(e.target.checked)} />
        Metrónomo
      </label>
    </div>
  )
}
