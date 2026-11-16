import { useApp } from '../state/store'
import { usePadLights } from './padLights'
import { PAD_KEYS, PADS_PER_BANK, padDown, padSource, padUp } from './pads'

/** Filas de arriba a abajo, cada una de izquierda a derecha (pad 1 abajo a la izquierda). */
const LAYOUT = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3]

export function Pads() {
  const ui = useApp((s) => s.ui)
  const project = useApp((s) => s.history.present)
  const lit = usePadLights((s) => s.lit)
  const source = padSource(project, ui)
  const banks = Math.max(1, Math.ceil(source.count / PADS_PER_BANK))
  const bank = Math.min(ui.padBank, banks - 1)
  const setUi = useApp((s) => s.setUi)
  const track = ui.view === 'track' && ui.selectedTrackId ? project.tracks[ui.selectedTrackId] : undefined

  return (
    <section className="pads">
      <header>
        <h2>Pads</h2>
        <span className="muted small">{track ? track.name : source.kind === 'sample' ? 'Slices del sample' : ''}</span>
        {banks > 1 && (
          <div className="banks">
            {Array.from({ length: banks }, (_, b) => (
              <button key={b} className={b === bank ? 'active' : ''} onClick={() => setUi({ padBank: b })}>
                {String.fromCharCode(65 + b)}
              </button>
            ))}
          </div>
        )}
        {source.kind === 'sample' && source.count === 0 && <span className="muted small">Corta el sample para llenar los pads.</span>}
      </header>
      <div className="pad-grid">
        {LAYOUT.map((pad) => {
          const index = bank * PADS_PER_BANK + pad
          const exists = index < source.count
          const label = exists ? source.label(index) : null
          const classes = ['pad']
          if (!exists) classes.push('off')
          else if (!label) classes.push('empty')
          if (lit.has(index)) classes.push('lit')
          return (
            <button
              key={pad}
              className={classes.join(' ')}
              disabled={!exists}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                padDown(index, e.timeStamp)
              }}
              onPointerUp={(e) => padUp(index, e.timeStamp)}
              onPointerCancel={(e) => padUp(index, e.timeStamp)}
            >
              <span className="pad-num">{exists ? index + 1 : ''}</span>
              {label && source.kind === 'track' && track?.kind === 'drumRack' && <span className="pad-label">{label}</span>}
              <span className="pad-key">{PAD_KEYS[pad]!.toUpperCase()}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
