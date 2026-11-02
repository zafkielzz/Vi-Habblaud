// CONTRACT for the art module (procedural pixel art).
//
// - Implementation: client/src/art/index.ts (+ internal files in art/).
// - Consumers: client/src/world/** (office rendering) and client/src/ui/** (avatars).
// - Rule: changes here must be ADDITIVE. Do not rename/remove types, kinds, or functions.
//
// General conventions
// - World in "world pixels"; 1 tile = TILE px. Everything is 1x pixel art, scaled by the camera
//   with imageSmoothingEnabled = false.
// - Perspective: top-down 3/4, as in modern pixel art office tilesets. See ART DIRECTION below. We see the top and FRONT (south face)
//   of objects. North walls show the face (2 tiles high); side and south walls appear
//   only as a thin "cap" to avoid hiding room interiors.
// - Light comes from top/left: lighter tops, darker front faces, soft shadow underneath.
// - Sprites are cached HTMLCanvasElement instances (generate once, reuse always).

// ART DIRECTION (modern, clean, and detailed top-down 3/4 pixel art office)
// - Bright and clean office: light porcelain tile with subtle grout, warm wood in lounge, light walls,
//   bluish glass partitions, bookshelves with colorful binders, potted plants, paintings, nameplate.
// - Desk clusters with 1–2 glowing bluish screen monitors, keyboard, mouse, mug, papers; graphite chairs.
// - Kitchenette with light countertop and marble backsplash, stainless sink, coffee maker, fridge; water cooler with blue jug.
// - Lounge with blue/slate sofa and orange cushions, rug, coffee table, bonsai, large printer.
// - Light palette (cool neutrals + warm wood + saturated accents on objects); 1px dark slate outline
//   (not black); 3–4 tones per material; specular highlights; contact shadows; plenty of small details.

import type { AppearanceParts } from '../../../shared/appearance';

export const TILE = 16;

export type Dir = 'down' | 'up' | 'left' | 'right';

/**
 * Character poses. In parentheses: expected frame count.
 * "Seated" poses (sit/type/sleep) assume the character is on a seat: legs
 * are hidden/folded and the body is ~4px lower than standing.
 */
export type Pose =
  | 'stand' // standing idle, subtle breathing (2)
  | 'walk' // walking (4)
  | 'run' // running, wider strides and leaning body (4)
  | 'sit' // seated idle (2)
  | 'type' // seated typing — usually dir 'up', back to camera, alternating arms (4)
  | 'sleep' // seated dozing off: head down (2)
  | 'drink' // standing bringing cup to mouth (2) — use with held 'coffee' or 'water'
  | 'use' // standing operating machine: arm extended forward (2)
  | 'raise_hand' // arm raised waving — requesting attention (2); works standing and seated (opts.seated)
  | 'talk' // standing talking, gesturing (2)
  | 'stretch' // standing stretching, arms up (2)
  | 'read' // standing or seated holding book/papers in front (2)
  | 'play' // ping-pong: paddle in hand, alternating arm (2)
  | 'wait' // seated waiting for something to finish (e.g. a shell), leaning back (2). With held 'popcorn': hand moves from bucket to mouth, eating popcorn; without item: arms crossed, tapping fingers/foot
  // --- social life (additive)
  | 'cheer' // cheering: both arms up, clenched fists, open mouth, small hop on frame 1 (2). Standing or seated (opts.seated)
  | 'laugh' // laughing out loud: arched closed eyes, open mouth, one hand on belly, body shaking 1px (2). Standing or seated
  | 'game' // playing videogame: controller (held 'controller') in both hands in front of chest, thumbs moving, body leaning toward screen (2). Standing or seated
  | 'rps' // rock-paper-scissors. held 'none': closed fist moving up (frame 0) and down (1) on "rock-paper-scissors" count; held 'rock'|'paper'|'scissors': arm extended forward showing gesture (2). Standing (seated also works)
  | 'groom' // in front of mirror (usually dir 'up', back turned): one hand near face/hair moving back and forth — lipstick, comb, fixing hair (2). optional held 'lipstick'|'comb'. Standing
  | 'sulk'; // sulking (lost bet/match): slumped shoulders, head down, half-closed eyes, hanging arms (2). Standing or seated

export type HeldItem = 'none' | 'coffee' | 'water' | 'papers' | 'laptop' | 'book' | 'box' | 'paddle' | 'popcorn'
  // --- social life (additive)
  | 'controller' // game controller (pose 'game'; standing/walking, in one hand)
  | 'rock' // pose 'rps': closed fist (rock)
  | 'paper' // pose 'rps': open hand, palm down (paper)
  | 'scissors' // pose 'rps': index and middle fingers in V (scissors)
  | 'phone' // phone (with 'read' or 'sit': looking at screen, scrolling thumb; glowing bluish screen)
  | 'lipstick' // lipstick (pose 'groom')
  | 'comb'; // comb (pose 'groom')

export type HairStyle =
  | 'short' | 'buzz' | 'spiky' | 'side_part' | 'curly' | 'afro' | 'bob' | 'long' | 'ponytail' | 'bun' | 'pigtails'
  | 'mohawk' | 'bald' | 'wavy';

export type TopStyle = 'tshirt' | 'hoodie' | 'shirt_tie' | 'sweater' | 'jacket' | 'blouse' | 'polo';

export type Accessory = 'none' | 'glasses' | 'sunglasses' | 'headphones' | 'cap' | 'beanie' | 'earrings' | 'bow';

export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  eyes: string;
  top: string;
  topAccent: string;
  topStyle: TopStyle;
  bottom: string;
  shoes: string;
  accessory: Accessory;
  accessoryColor: string;
  /** Lanyard around the neck (used to distinguish subagents). null = no lanyard. */
  lanyard: string | null;
  look: 'f' | 'm';
  /** (Optional, additive) Facial hair — only drawn for look 'm'. Absent = no facial hair. */
  facialHair?: 'none' | 'stubble' | 'beard' | 'mustache' | 'goatee';
  /** (Optional, additive) Bottom clothing style. Absent = pants. */
  bottomStyle?: 'pants' | 'shorts' | 'skirt';
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Dynamic regions inside a sprite (in sprite px, relative to top-left corner). */
export type SpriteRectName = 'screen' | 'board' | 'glass' | 'face' | 'tv' | 'sign' | 'art' | 'glow'
  /**
   * (Additive) 2nd monitor/laptop of `desk`, when present. Sprite already includes fixed dimmed
   * content (spreadsheet/editor/dashboard); world MAY draw on top (e.g. drawScreen 'off'
   * when room lights go out, or another mode when owner is working). Ignoring also works.
   */
  | 'screen2';

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** Anchor point inside the sprite (px). See conventions in FurnitureDef / characterSprite. */
  ax: number;
  ay: number;
  rects?: Partial<Record<SpriteRectName, Rect>>;
}

/** `front` is drawn ON TOP of whoever is sitting/inside (e.g. chair backrest, stall door). */
export interface FurnitureSprites {
  base: Sprite;
  front?: Sprite;
}

export interface CharacterFrameRequest {
  appearance: Appearance;
  dir: Dir;
  pose: Pose;
  frame: number;
  held?: HeldItem;
  /** For poses that can be standing or seated (raise_hand, read, talk). */
  seated?: boolean;
  /** Seasonal accessory; absent keeps original appearance. */
  costume?: 'santa' | 'witch' | 'pumpkin' | 'vampire';
}

export type FurnitureKind =
  // --- office (project rooms)
  | 'desk' // 2x1. Desk with monitor facing SOUTH (screen visible to camera), keyboard and mug. rects.screen = screen area.
  | 'desk_back' // 2x1. Desk seen from the other side: we see the BACK of the monitor; person sits NORTH of it, facing down (face visible). For face-to-face desk clusters. Same variants as desk.
  | 'office_chair_front' // 1x1 seat facing DOWN (backrest to north, drawn BEFORE the character; no front). Counterpart of desk_back.
  | 'office_chair' // 1x1 seat. Backrest to south (character sits facing up, back turned). front = backrest.
  | 'bookshelf' // 2x1 against north wall. Colorful books.
  | 'filing_cabinet' // 1x1 filing cabinet.
  | 'printer' // 1x1 printer on low credenza.
  | 'trash_bin' // 1x1 small trash bin (can be much smaller than the tile).
  | 'plant_small' // 1x1 small potted plant. variants: 'fern' | 'succulent' | 'flower'
  | 'plant_tall' // 1x1 tall plant (up to ~2 tiles high). variants: 'palm' | 'ficus' | 'monstera' | 'bonsai'
  | 'glass_partition' // 1x1 glass partition segment on white base (half-wall + bluish glass with reflection). variants: 'h' (runs east-west) | 'v' (runs north-south) | 'end' (post/column)
  | 'binder_shelf' // 1x1 tall and narrow shelving unit with colorful binders (blue/orange/green) and boxes.
  | 'meeting_table' // 3x2 meeting table / workbench for subagents.
  | 'stool' // 1x1 simple seat (stool). Character can sit in any direction.
  | 'floor_lamp' // 1x1 floor lamp. rects.glow = center of light.
  | 'water_cooler' // 1x1 water cooler with blue jug. Usage: character stands SOUTH, facing up.
  // --- mounted on north wall (mount: 'wall')
  | 'whiteboard' // 3 tiles wide. Kanban board. rects.board = area where render draws post-its.
  | 'window' // 2 tiles. Window; rects.glass = glass (render draws sky before frame).
  | 'clock' // 1 tile. Clock; rects.face = clock face (hands drawn by render).
  | 'poster' // 1 tile. variants: 'code' | 'coffee' | 'rocket' | 'cat' | 'bug' | 'ship_it'
  | 'painting' // 2 tiles. Framed painting; rects.art = painting area (can receive AI-generated image).
  | 'tv' // 2 tiles. Wall-mounted TV; rects.tv = screen.
  | 'light_switch' // 1 tile (sprite is small). variants: 'on' | 'off'
  | 'elevator' // 2 tiles. Elevator door; state 0..4 = closed door .. fully open. Includes light/arrow above.
  | 'door_frame' // 2 tiles. Door frame drawn over doorway on north wall face.
  | 'sign' // 3 tiles. Room nameplate; rects.sign = text area (render writes name).
  | 'mirror' // 1 tile. Mirror (above bathroom sinks). (Additive) rects.glass = reflective area (world can draw reflection of whoever stands in front).
  | 'shelf_wall' // 2 tiles. Wall shelf with objects.
  // --- kitchenette / coffee
  | 'counter' // 1x1 counter segment (against north wall). variants: 'plain' | 'drawers'
  | 'counter_sink' // 1x1 counter with sink.
  | 'coffee_machine' // 1x1 counter with coffee machine on top. Usage: character SOUTH, facing up. state 0 = idle, 1 = brewing coffee.
  | 'microwave' // 1x1 counter with microwave.
  | 'fridge' // 1x1 tall refrigerator.
  | 'vending_machine' // 1x1 tall illuminated snack vending machine.
  | 'cafe_table' // 1x1 small round table.
  | 'cafe_chair' // 1x1 seat. variant = direction seated person faces: 'up' | 'down' | 'left' | 'right'. front when 'up'.
  // --- lounge
  | 'sofa' // 3x1 seat. variant 'down' (facing camera) | 'up' (back turned, front = backrest).
  | 'armchair' // 1x1 seat. variants same as cafe_chair.
  | 'coffee_table' // 2x1 coffee table.
  | 'pingpong_table' // 3x2 ping-pong table (vertical net in middle; players at west/east ends).
  | 'beanbag' // 1x1 beanbag (seat). color variants: 'red' | 'blue' | 'yellow' | 'green'
  | 'arcade' // 1x1 arcade cabinet (usage as machine: character south facing up). (Additive) rects.screen = screen (world can draw drawScreen 'game' on top during a match).
  // --- bathroom
  | 'toilet_stall' // 2x2 toilet stall. Character enters through door (SOUTH side) and vanishes. front = partition/door. state 0 = vacant (ajar door), 1 = occupied (closed door, red indicator).
  | 'sink' // 1x1 sink with cabinet (against north wall; use 'mirror' on wall above).
  // --- reception
  | 'reception_desk' // 3x1 reception desk.
  | 'bench'; // 2x1 waiting bench (seat, facing down).

export interface FurnitureDef {
  mount: 'floor' | 'wall';
  /**
   * Floor: tiles occupied on ground (w x h).
   * Wall: width in tiles on wall face (h ignored).
   */
  footprint: { w: number; h: number };
  /** Floor: whether tiles block movement. Seats do not block (character "enters" them). */
  blocks: boolean;
  /** Is a seat (character can sit on it). */
  seat?: boolean;
  variants?: readonly string[];
  /** Number of visual states (e.g. elevator 5, toilet_stall 2). */
  states?: number;
}

/**
 * Furniture catalog. Anchor (ax, ay) of furniture sprites:
 * - mount 'floor': (ax, ay) corresponds to the BOTTOM CENTER point of footprint in world,
 *   i.e. (x0 + w*TILE/2, y0 + h*TILE) where (x0, y0) is top-left corner of footprint.
 *   The sprite can extend upward (height) and slightly to the sides.
 * - mount 'wall': (ax, ay) corresponds to the BOTTOM CENTER point of wall segment, i.e.,
 *   at the baseboard line (base of wall face). Sprite "floats" at the correct height on its own.
 * Depth sorting: by world anchor y (larger y = drawn later).
 */
export const FURNITURE: Readonly<Record<FurnitureKind, FurnitureDef>> = {
  desk: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true, variants: ['wood', 'white', 'dark'] },
  desk_back: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true, variants: ['wood', 'white', 'dark'] },
  office_chair_front: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['black', 'blue', 'red', 'green', 'gray'] },
  office_chair: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['black', 'blue', 'red', 'green', 'gray'] },
  bookshelf: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true },
  filing_cabinet: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  printer: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  trash_bin: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  plant_small: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['fern', 'succulent', 'flower'] },
  plant_tall: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['palm', 'ficus', 'monstera', 'bonsai'] },
  glass_partition: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['h', 'v', 'end'] },
  binder_shelf: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  meeting_table: { mount: 'floor', footprint: { w: 3, h: 2 }, blocks: true },
  stool: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true },
  floor_lamp: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  water_cooler: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  whiteboard: { mount: 'wall', footprint: { w: 3, h: 0 }, blocks: false },
  window: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  clock: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false },
  poster: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false, variants: ['code', 'coffee', 'rocket', 'cat', 'bug', 'ship_it'] },
  painting: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  tv: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  light_switch: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false, variants: ['on', 'off'] },
  elevator: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false, states: 5 },
  door_frame: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  sign: { mount: 'wall', footprint: { w: 3, h: 0 }, blocks: false },
  mirror: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false },
  shelf_wall: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  counter: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['plain', 'drawers'] },
  counter_sink: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  coffee_machine: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, states: 2 },
  microwave: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  fridge: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  vending_machine: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  cafe_table: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  cafe_chair: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['up', 'down', 'left', 'right'] },
  sofa: { mount: 'floor', footprint: { w: 3, h: 1 }, blocks: false, seat: true, variants: ['down', 'up'] },
  armchair: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['up', 'down', 'left', 'right'] },
  coffee_table: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true },
  pingpong_table: { mount: 'floor', footprint: { w: 3, h: 2 }, blocks: true },
  beanbag: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['red', 'blue', 'yellow', 'green'] },
  arcade: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  toilet_stall: { mount: 'floor', footprint: { w: 2, h: 2 }, blocks: true, states: 2 },
  sink: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  reception_desk: { mount: 'floor', footprint: { w: 3, h: 1 }, blocks: true },
  bench: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: false, seat: true },
};

export type FloorKind =
  | 'carpet' // project rooms (uses room theme tint/tint2)
  | 'wood' // lounge
  | 'tile_check' // kitchenette (checkerboard)
  | 'tile_white' // bathroom
  | 'concrete' // hallway (polished/burnished concrete)
  | 'marble' // reception
  | 'grass' // outdoor area
  | 'sidewalk' // outdoor sidewalk
  | 'street'; // outdoor street (lanes drawn by render if desired)

export type WallPattern = 'plain' | 'stripes' | 'tiles' | 'wood_panel' | 'brick' | 'glass' | 'marble';

export interface WallStyle {
  /** Base color of wall face. */
  base: string;
  /** Accent color (baseboard/trim). */
  trim?: string;
  pattern?: WallPattern;
  /** Building exterior wall (more subdued tone, may have brick/concrete texture). */
  exterior?: boolean;
}

export interface Doorway {
  /** Doorway start in world px (absolute) and width in px. */
  x: number;
  w: number;
}

export type ScreenMode =
  | 'off' // monitor off (matte navy blue with diagonal reflection; never pitch black)
  | 'standby' // (additive) on but unused: blue background with slowly pulsing logo — e.g. vacant desk with room lit
  | 'idle' // subtle screensaver
  | 'code' // editor with scrolling colored lines of code
  | 'terminal' // dark terminal with appearing green text
  | 'browser' // web page (address bar + blocks)
  | 'search' // search results / magnifying glass
  | 'chat' // chat (alternating bubbles)
  | 'docs' // text document
  | 'tasks' // checklist
  | 'alert' // blinking amber screen (needs attention)
  | 'progress' // dark terminal with progress bar / spinner moving (waiting for command to finish)
  // --- social life (additive; designed for lounge TV and arcade, but valid for any screen)
  | 'show' // animated TV show; FIXED mapping by `seed`: seed % 3 === 0 soccer (field, players, ball; periodically ball enters goal and screen flashes "GOAL"), 1 soap opera (two faces in close-up, hearts), 2 cartoon (vivid colors)
  | 'game'; // videogame (two players); FIXED mapping by `seed`: seed % 2 === 0 split-screen racing (two cars on track), 1 fighting (two fighters and health bars)

export interface RoomTheme {
  carpet: string;
  carpet2: string;
  wall: WallStyle;
  accent: string;
  deskVariant: string;
  chairVariant: string;
}

/** Small pixel art icons (~8–12px) for above-head states. */
export type IconName = 'alert' | 'question' | 'zzz' | 'check' | 'heart' | 'coffee' | 'music' | 'idea' | 'sweat' | 'star' | 'lightning' | 'chat' | 'box' | 'wave'
  | 'hourglass' // hourglass (waiting for a shell)
  | 'hourglass_flip' // same hourglass flipping (alternate with 'hourglass' to animate)
  | 'cobweb' // cobweb (~12px) for corner of chair/character when wait gets long
  | 'storm' // small rain cloud with lightning (something failed)
  // --- social life (additive)
  | 'coin' // gold coin with sparkle (~8px) — earned money
  | 'sparkle' // 4-pointed sparkle (~9px) — groomed in mirror
  | 'trophy' // gold trophy (~10px) — won match/bet
  | 'hand_rock' // rock gesture (fist) (~10px) — rock-paper-scissors reveal
  | 'hand_paper' // paper gesture (open hand) (~10px)
  | 'hand_scissors'; // scissors gesture (V) (~10px)

/** Signature that art/index.ts must export (world and UI depend on this). */
export interface ArtModule {
  appearanceFromSeed(seed: number, opts?: { look?: 'f' | 'm'; sub?: boolean; parts?: AppearanceParts }): Appearance;
  /** Anchor: (ax, ay) = center of feet (point on floor). Character occupies ~14–18px width and ~24–28px height. */
  characterSprite(req: CharacterFrameRequest): Sprite;
  poseFrameCount(pose: Pose): number;
  /** Duration of each pose frame in ms. */
  poseFrameDuration(pose: Pose): number;
  /**
   * `opts.seed` (optional, additive) varies details of repeated items (desk objects, bookshelf
   * books, binders...). Without seed, uses variation 0. Sprites stay cached by (kind, variant, state, seed % N).
   */
  furnitureSprites(kind: FurnitureKind, variant?: string, state?: number, opts?: { seed?: number }): FurnitureSprites;
  /** Draws floor area (world px, multiples of TILE). `seed` varies per-tile details. */
  drawFloor(ctx: CanvasRenderingContext2D, kind: FloorKind, x: number, y: number, w: number, h: number, opts: { seed: number; tint?: string; tint2?: string }): void;
  /** Decorative rug over floor. */
  drawRug(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, seed: number): void;
  /** North wall face: height 2*TILE from y, with dark "cap" on top and baseboard at base. */
  drawWallFace(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, style: WallStyle, opts?: { doorways?: Doorway[] }): void;
  /** Wall cap (sides and sections without face), arbitrary rectangle. */
  drawWallTop(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, style: WallStyle): void;
  /** South wall: 1 tile high (cap + low parapet), with optional doorways. */
  drawSouthWall(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, style: WallStyle, opts?: { doorways?: Doorway[] }): void;
  /** Animated screen content (monitor/TV). `r` in world px. `t` in ms. */
  drawScreen(ctx: CanvasRenderingContext2D, r: Rect, mode: ScreenMode, t: number, seed: number): void;
  /** Kanban board post-its (columns: to do / doing / done). */
  drawBoard(ctx: CanvasRenderingContext2D, r: Rect, items: readonly { status: 'pending' | 'in_progress' | 'completed' }[], t: number): void;
  /** Sky + horizon seen through window according to local hour (0–24, fractional). */
  drawWindowView(ctx: CanvasRenderingContext2D, r: Rect, hour: number, t: number, seed: number): void;
  drawClock(ctx: CanvasRenderingContext2D, r: Rect, date: Date): void;
  roomTheme(seed: number): RoomTheme;
  iconSprite(name: IconName): Sprite;
  /**
   * (Optional, additive) Soccer play from drawScreen('show') with seed % 3 === 0, at time `t`:
   * from `progress >= goalAt` onward screen flashes "GOAL" (ball into right goal if `right`). World
   * uses this so crowd cheers along with TV.
   */
  footballLance?(t: number, seed: number): { lance: number; progress: number; right: boolean; period: number; goalAt: number };
  /** Avatar (head + shoulders) scaled for UI. `parts`: pieces of edited character (see AgentInfo.parts). */
  avatarCanvas(seed: number, opts?: { look?: 'f' | 'm'; sub?: boolean; scale?: number; parts?: AppearanceParts }): HTMLCanvasElement;
}
