/**
 * Una toma y cómo se vuelca al proyecto.
 *
 * `applyTake` es una función pura `(project, take) → project`: la UI la usa
 * para registrar toda la toma como UN paso de deshacer, y el motor la usa
 * durante la grabación para ir oyendo lo grabado (se aplica siempre sobre
 * el proyecto base, así que repetirla no acumula nada).
 *
 * DECISIONES (ver docs/ENGINE.md):
 *
 * 1. Note-off después de dar la vuelta al loop. La nota se queda donde
 *    empezó y conserva su duración real, aunque pase del final del patrón
 *    (el secuenciador la termina en la vuelta siguiente). Tope: el largo
 *    del patrón, para que no se pise consigo misma.
 *
 * 2. Golpes adelantados al tiempo 1. Lo tocado hasta `preRollTicks` antes
 *    del inicio de la grabación (final del count-in) se conserva. En un
 *    patrón en loop cae justo antes del final (tick = largo − adelanto):
 *    suena exactamente como se tocó, y al cuantizar da la vuelta al tick 0.
 *    En un clip nuevo (grabación lineal) no hay "antes": se pega al inicio
 *    del clip.
 *
 * 3. `replace` en loops sucesivos. Reemplazar significa "esta toma
 *    sustituye a lo que había": se borran las notas ANTERIORES de las
 *    pistas armadas en la zona recorrida (todo el patrón si se dio al menos
 *    una vuelta); lo grabado en vueltas sucesivas de la misma toma se
 *    acumula como en overdub. Dejar correr el loop sin tocar no borra lo
 *    que acabas de grabar.
 *
 * 4. Notas aún pulsadas al parar: se cierran en el punto de parada y se
 *    conservan.
 */
import { produce } from 'immer'
import {
  gridTicks,
  ticksPerBar,
  type ClipId,
  type Note,
  type NoteId,
  type Pattern,
  type PatternClip,
  type PatternId,
  type Project,
  type RecordMode,
  type Ticks,
  type TrackId,
  type TransportMode,
} from '../../model'
import { posMod } from '../util'

export interface TakeNote {
  id: NoteId
  trackId: TrackId
  pitch: number
  velocity: number
  /**
   * Posición del transporte donde se tocó (ya compensada la latencia), en
   * ticks enteros. Puede ser menor que `startTick` si fue un golpe adelantado.
   */
  tick: Ticks
  /** Duración real, medida sin vueltas de loop. */
  durationTicks: Ticks
}

/** Una toma: JSON puro, igual que el proyecto. */
export interface Take {
  mode: RecordMode
  transportMode: TransportMode
  /** Pistas armadas al empezar a grabar. */
  armedTrackIds: TrackId[]
  /** Posición del transporte donde empezó la grabación (tras el count-in). */
  startTick: Ticks
  /** Ticks que duró la grabación. null = toma en curso. */
  lengthTicks: Ticks | null
  notes: TakeNote[]
  /** Ids reservados por pista para el patrón/clip que haga falta crear. */
  reserved: Record<TrackId, { patternId: PatternId; clipId: ClipId }>
}

interface Range {
  start: number
  end: number
}

/** Zona de posiciones que recorrió la toma. */
function visitedRange(project: Project, take: Take): Range {
  const start = take.startTick
  if (take.lengthTicks === null) return { start, end: Infinity }
  const end = start + take.lengthTicks
  const loop = project.songLoop
  if (
    take.transportMode === 'song' &&
    loop.enabled &&
    loop.endTick > loop.startTick &&
    start < loop.endTick &&
    end > loop.endTick
  ) {
    return { start: Math.min(start, loop.startTick), end: loop.endTick }
  }
  return { start, end }
}

/** Borra del patrón las notas cuya posición cae en [a, b) del transporte. */
function removeCovered(pattern: Pattern, origin: number, a: number, b: number): void {
  const len = pattern.lengthTicks
  if (!(len > 0) || b <= a) return
  const inLoop = (n: Note): boolean => n.tick >= 0 && n.tick < len
  if (b - a >= len) {
    pattern.notes = pattern.notes.filter((n) => !inLoop(n))
    return
  }
  const from = posMod(a - origin, len)
  pattern.notes = pattern.notes.filter((n) => !inLoop(n) || posMod(n.tick - from, len) >= b - a)
}

function addNote(pattern: Pattern, tick: number, source: TakeNote): void {
  const durationTicks = Math.max(1, Math.min(source.durationTicks, pattern.lengthTicks))
  pattern.notes.push({
    id: source.id,
    tick,
    durationTicks,
    pitch: source.pitch,
    velocity: source.velocity,
    // El timing real queda guardado: cuantizar siempre parte de aquí.
    recorded: { tick, durationTicks },
  })
}

function newPattern(project: Project, id: PatternId, trackId: TrackId, lengthTicks: number): Pattern {
  const count = Object.values(project.patterns).filter((p) => p.trackId === trackId).length
  const pattern: Pattern = {
    id,
    trackId,
    name: `Toma ${count + 1}`,
    lengthTicks,
    notes: [],
    swing: 0,
    swingGridTicks: gridTicks(16),
  }
  project.patterns[id] = pattern
  return pattern
}

/** Vuelca la toma al proyecto. Pura: devuelve un proyecto nuevo. */
export function applyTake(project: Project, take: Take): Project {
  return produce(project, (draft) => {
    const bar = ticksPerBar(draft.timeSignature)
    const ceilBar = (tick: number): number => Math.ceil(tick / bar) * bar
    const floorBar = (tick: number): number => Math.floor(tick / bar) * bar
    const range = visitedRange(draft, take)

    for (const trackId of take.armedTrackIds) {
      const track = draft.tracks[trackId]
      if (!track || track.kind === 'audio') continue
      const notes = take.notes.filter((n) => n.trackId === trackId).sort((a, b) => a.tick - b.tick)
      const reserved = take.reserved[trackId]
      /** Notas que no caen en ningún patrón existente: van a un clip nuevo. */
      let loose: TakeNote[] = []

      if (take.mode === 'linear') {
        loose = notes
      } else if (take.transportMode === 'pattern') {
        let pattern = track.activePatternId ? draft.patterns[track.activePatternId] : undefined
        const others = Object.values(draft.tracks)
          .map((t) => (t.activePatternId ? draft.patterns[t.activePatternId] : undefined))
          .filter((p) => p !== undefined)
          .map((p) => p.lengthTicks)
        // Sin ningún patrón de referencia, el largo sale de lo que dure la
        // toma: mientras sigue en curso todavía no hay loop que crear.
        const undecided = others.length === 0 && take.lengthTicks === null
        if (!pattern && notes.length > 0 && reserved && !undecided) {
          // La pista no tenía patrón: se crea. Si hay otros patrones sonando
          // se usa su largo (es el loop que se oye); si no, lo que duró la toma.
          const played = take.lengthTicks ?? 0
          const length = others.length > 0 ? Math.max(...others) : Math.max(bar, ceilBar(played))
          pattern = newPattern(draft, reserved.patternId, trackId, length)
          track.activePatternId = pattern.id
        }
        if (pattern) {
          if (take.mode === 'replace') removeCovered(pattern, 0, range.start, range.end)
          for (const n of notes) addNote(pattern, posMod(n.tick, pattern.lengthTicks), n)
        }
      } else {
        const clips = Object.values(draft.clips).filter(
          (c): c is PatternClip => c.kind === 'pattern' && c.trackId === trackId,
        )
        const clipAt = (tick: number): PatternClip | undefined =>
          clips.find((c) => tick >= c.startTick && tick < c.startTick + c.lengthTicks)
        if (take.mode === 'replace') {
          for (const clip of clips) {
            const pattern = draft.patterns[clip.patternId]
            const a = Math.max(range.start, clip.startTick)
            const b = Math.min(range.end, clip.startTick + clip.lengthTicks)
            if (pattern) removeCovered(pattern, clip.startTick - clip.offsetTicks, a, b)
          }
        }
        for (const n of notes) {
          const late = Math.max(n.tick, take.startTick)
          const clip = clipAt(n.tick) ?? clipAt(late)
          const pattern = clip && draft.patterns[clip.patternId]
          if (!clip || !pattern || !(pattern.lengthTicks > 0)) {
            loose.push(n)
            continue
          }
          const tick = clipAt(n.tick) === clip ? n.tick : late
          addNote(pattern, posMod(tick - clip.startTick + clip.offsetTicks, pattern.lengthTicks), n)
        }
      }

      if (loose.length === 0 || !reserved) continue
      // Clip nuevo en el arreglo, de compás a compás.
      const linear = take.mode === 'linear'
      const first = linear ? range.start : Math.min(...loose.map((n) => Math.max(n.tick, take.startTick)))
      const clipStart = floorBar(first)
      const at = (n: TakeNote): number => Math.max(n.tick, clipStart)
      const lastEnd = Math.max(...loose.map((n) => at(n) + n.durationTicks))
      const until = linear && Number.isFinite(range.end) ? range.end : lastEnd
      const lengthTicks = Math.max(bar, ceilBar(until) - clipStart)
      const pattern = newPattern(draft, reserved.patternId, trackId, lengthTicks)
      for (const n of loose) addNote(pattern, Math.min(at(n) - clipStart, lengthTicks - 1), n)
      draft.clips[reserved.clipId] = {
        id: reserved.clipId,
        kind: 'pattern',
        trackId,
        patternId: pattern.id,
        startTick: clipStart,
        lengthTicks,
        offsetTicks: 0,
      }
    }
  })
}
