/**
 * Estado de la app. El proyecto vive en un historial (deshacer/rehacer);
 * la selección y otras cosas de la interfaz van aparte y no se deshacen.
 */
import type { Draft } from 'immer'
import { create } from 'zustand'
import { createEmptyProject, type AssetId, type Project, type SliceId, type TrackId } from '../model'
import { commit, createHistory, redo, reset, undo, type History } from './history'

export interface UiState {
  selectedAssetId: AssetId | null
  /** Slices seleccionados del asset actual, en orden de selección. */
  selectedSliceIds: SliceId[]
  /** Ajustar marcadores al cruce por cero más cercano. */
  snapToZero: boolean
  /** Banco de pads visible (0 = pads 1–16). */
  padBank: number
  selectedTrackId: TrackId | null
  /** Qué se ve al centro: el editor de slices o el secuenciador de la pista. */
  view: 'sample' | 'track'
  /** Resolución de la grilla de pasos, en ticks. */
  stepTicks: number
}

const INITIAL_UI: UiState = {
  selectedAssetId: null,
  selectedSliceIds: [],
  snapToZero: true,
  padBank: 0,
  selectedTrackId: null,
  view: 'sample',
  stepTicks: 240,
}

interface AppState {
  history: History<Project>
  ui: UiState
  /** Aplica un cambio al proyecto como un paso de deshacer. */
  change(label: string, recipe: (draft: Draft<Project>) => void): void
  undo(): void
  redo(): void
  /**
   * Reemplaza el proyecto por uno calculado fuera (funciones puras como
   * applyTake) como un paso de deshacer. Solo copia las partes que cambiaron.
   */
  replace(label: string, next: Project): void
  /** Carga un proyecto sin historial (al abrir). */
  load(project: Project): void
  setUi(patch: Partial<UiState>): void
}

export const useApp = create<AppState>()((set) => ({
  history: createHistory(createEmptyProject()),
  ui: INITIAL_UI,
  change: (label, recipe) => set((s) => ({ history: commit(s.history, label, recipe) })),
  replace: (label, next) =>
    set((s) => ({
      history: commit(s.history, label, (draft) => {
        const base = s.history.present
        for (const key of Object.keys(next) as (keyof Project)[]) {
          if (next[key] !== base[key]) (draft as Record<string, unknown>)[key] = next[key]
        }
      }),
    })),
  undo: () => set((s) => ({ history: undo(s.history) })),
  redo: () => set((s) => ({ history: redo(s.history) })),
  load: (project) =>
    set({
      history: reset(project),
      ui: {
        ...INITIAL_UI,
        selectedAssetId: (Object.keys(project.assets)[0] as AssetId | undefined) ?? null,
        selectedTrackId: project.trackOrder[0] ?? null,
      },
    }),
  setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),
}))

export const useProject = <T>(select: (p: Project) => T): T => useApp((s) => select(s.history.present))

export function getProject(): Project {
  return useApp.getState().history.present
}
