// Fictional project names for Habblaud World (PLANO.md, sections 4.3 and 6.2): each floor of a building gets an id
// from this list ("ipe", "jade", "aurora"...), picked by the server from the random floor id, and the
// visitor's browser translates it ("Project Ipê", "Proyecto Ipê", "Projet Ipê"). The label changes
// along with the floor id (rotation of 24 h ± 6 h), so it identifies no actual project.
//
// ASCII-only, neutral and brand-free ids: 20 trees, 20 stones, and 20 constellations (and the aurora). Order matters
// in the draw (index = hash of floor id): do not reorder or remove items; appending at the end only affects draws of
// new floors after the next rotation.
//
// Self-contained file (no imports), to be copied identically between both repositories. Source is the public repo
// (shared/world/floor-names.ts, with labels translated via tr() in shared/world/floor-labels.ts); the world server
// keeps an exact copy (protocol/floor-names.ts, with hash verified by tests).

export const FLOOR_NAME_IDS = [
  // Trees
  'ipe', 'jacaranda', 'jatoba', 'peroba', 'cedro', 'aroeira', 'araucaria', 'buriti', 'carnauba', 'figueira',
  'oliveira', 'carvalho', 'salgueiro', 'sequoia', 'baoba', 'acacia', 'magnolia', 'cerejeira', 'pinheiro', 'palmeira',
  // Stones
  'jade', 'ambar', 'ametista', 'quartzo', 'topazio', 'turmalina', 'agata', 'onix', 'opala', 'safira',
  'rubi', 'esmeralda', 'granada', 'jaspe', 'malaquita', 'obsidiana', 'turquesa', 'citrino', 'peridoto', 'lapislazuli',
  // Constellations (and the aurora)
  'aurora', 'orion', 'lyra', 'cygnus', 'draco', 'andromeda', 'cassiopeia', 'perseus', 'phoenix', 'hydra',
  'aquila', 'carina', 'vela', 'centaurus', 'crux', 'pavo', 'columba', 'auriga', 'lupus', 'tucana',
] as const;

export type FloorNameId = (typeof FLOOR_NAME_IDS)[number];
