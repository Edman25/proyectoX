/**
 * Identificadores con "marca" de tipo: en runtime son strings, pero TypeScript
 * no deja pasar un TrackId donde se espera un PatternId.
 */
declare const brand: unique symbol
export type Id<Kind extends string> = string & { readonly [brand]: Kind }

export type AssetId = Id<'asset'>
export type SliceId = Id<'slice'>
export type TrackId = Id<'track'>
export type PadId = Id<'pad'>
export type PatternId = Id<'pattern'>
export type NoteId = Id<'note'>
export type ClipId = Id<'clip'>
export type ProjectId = Id<'project'>
export type ControllerProfileId = Id<'controllerProfile'>
export type ControlId = Id<'control'>

export function newId<T extends Id<string>>(): T {
  return crypto.randomUUID() as T
}
