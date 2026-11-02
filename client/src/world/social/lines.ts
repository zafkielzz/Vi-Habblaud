// Short speech lines of characters (speech bubbles) — pure. `{nome}` = a colleague, `{sala}` = a project,
// `{v}` = bet value, `{a}`/`{b}` = score. Nothing here depends on the speaker's gender.
import type { TraitId } from './persona';
import { tr } from '../../../../shared/i18n';

export type Pool = readonly string[];

export const INVITE = {
  tv: [tr('Wanna watch TV? 📺'), tr('Popcorn break? 🍿'), tr("The show's starting!"), tr('Wanna watch some TV?')],
  futebol: [tr("The game's about to start! ⚽"), tr('Wanna watch the soccer game?'), tr('The big rivalry game is on! ⚽')],
  novela: [tr('The soap opera is on! 📺'), tr("Wanna watch today's episode?")],
  desenho: [tr('Cartoons are on! 😄'), tr('Wanna watch cartoons?')],
  videogame: [tr('Up for a video game match? 🎮'), tr("Bet you can't beat me 🎮"), tr('Video games? Best of three!')],
  arcade: [tr('Arcade? 👾'), tr("Bet I'll beat your high score 👾"), tr('Hit the arcade?')],
  pingpong: [tr('Ping-pong? 🏓'), tr('Quick game? 🏓'), tr('Come play ping-pong!')],
  pingpongRival: [tr('Come get crushed at ping-pong 😏'), tr('Ping-pong rematch? 🏓')],
  kitchen: [tr('Grab a coffee? ☕'), tr('Coffee break? ☕'), tr('Break in the kitchen?')],
  kitchenGossip: [tr("I've got some gossip… 👀"), tr("Kitchen. Now. I've got news 👀")],
  talk: [tr('Hey, all good?'), tr('Hey, {nome}!'), tr('Wanna chat?'), tr("Hey, {nome}! What's up?")],
  rps: [tr('Rock-paper-scissors for 🪙{v}?'), tr('I bet 🪙{v} on rock-paper-scissors!'), tr('Rock, paper, scissors? 🪙{v}!')],
  rpsHonor: [tr('Rock-paper-scissors? Just for glory 😅'), tr('Rock-paper-scissors for nothing?')],
  mirror: [tr('Time for a touch-up? 💄'), tr('Mirror? I need to freshen up ✨')],
} satisfies Record<string, Pool>;

export const ACCEPT: Pool = [tr("Let's go!"), tr('Off we go!'), 'Fechado! 🤝', tr('Right now!'), tr('Oh yeah!'), tr('You bet!'), tr('Sure thing!')];
export const ACCEPT_BET: Pool = ['Fechado! 🤝', tr('Get your wallet ready 💰'), tr("You're gonna lose!"), tr('Deal!')];
export const ACCEPT_BROKE: Pool = [tr("I'm broke 😅 Just for glory!"), tr('No 🪙… play for nothing?')];
export const ACCEPT_SLEEPY: Pool = [tr('Huh? Oh… okay 😴'), tr("I'm up! Let's go."), tr("Five more minutes… fine, let's go.")];
export const ACCEPT_SHELL: Pool = [tr("While the build runs… let's go! ⏳"), tr("My command's running, there's time ⏳"), tr("I'm just waiting on the terminal anyway…")];
export const ACCEPT_STINGY: Pool = [tr('A bet? Just a little one 💰'), tr('Low stakes, okay?')];

export const TV = {
  futebol: {
    goal: ['GOOOL! ⚽', tr('GOAL!!'), tr('WHAT A GOAL! ⚽'), tr('What a screamer!')],
    miss: ['Uuuuh! 😱', tr('Off the post!'), tr('So close!'), tr("How'd he miss that?!")],
    against: [tr('Oh no! Their goal 😩'), tr('Rough times…'), tr('Wake up, defense!'), tr("I can't believe it…")],
    talk: [tr("The ref's a crook! 😤"), tr('What a play!'), tr('That goalie is way too good'), tr('Come on, team!'), tr('That was a penalty!'), tr("They're playing great!")],
  },
  novela: {
    twist: [tr('No way! 😱'), tr('I knew it!'), tr('What a twist!'), tr('No way!!')],
    love: [tr('These two! 😍'), 'Finalmente! 😍', tr('So romantic…')],
    talk: [tr("Shhh, it's starting!"), tr("Don't cry… 😭"), tr('That villain is no good'), tr('The finale is tomorrow!')],
  },
  desenho: {
    funny: ['KKKKK 😂', tr('Hahaha!'), tr('So good 😂'), tr('This cartoon is awesome!')],
    talk: [tr('I watched this as a kid!'), tr('A classic!'), tr('Look at his face 😂')],
  },
  end: [tr('Too good!'), tr('More tomorrow 📺'), tr('What an episode!'), tr('Worth the break!')],
} as const;

export const GAME = {
  trash: [tr("I'm passing you! 🏎️"), tr("What's with this lag?!"), 'Combo! 💥', tr("That doesn't count!"), tr('Too easy 😎'), tr('Just warming up…'), tr('Nobody can stop me!'), tr('Check this out!')],
  round: [tr('Won that one! 🏆'), tr('One-nothing!'), tr('Take that!')],
  cheer: [tr('Go, {nome}!'), tr('Whoooa!'), tr('What a play!'), tr('Press the button!')],
};

export const PINGPONG = {
  point: [tr('Point! 🏓'), tr('Take that!'), tr('Right on the edge!'), tr('Smash!'), tr('Return this one!')],
  cheer: [tr('Nice!'), tr('Go, {nome}!'), tr('Whoooa!'), tr('What a shot!')],
  final: ['{a} a {b}! 🏆', tr('I won {a} to {b}! 🏆')],
};

export const RPS = {
  count: [tr('Rock…'), tr('Paper…'), tr('Scissors!')],
  tie: [tr('Tie! Again!'), tr('Great minds think alike 😂'), tr('Again!')],
  win: [tr('I won! 💰'), tr("It's my day!"), tr('Hand over the 🪙!'), tr('Easy peasy 😎'), tr('Knew it!')],
  winHonor: [tr('I won! 😎'), tr('Knew it!'), tr("It's my day!")],
  lose: [tr("That didn't count!"), tr('Lucky you…'), tr('My money… 😭'), tr('Yeah, yeah…'), tr('I meant to throw rock!')],
  rematch: [tr('Rematch!'), tr('Best of three!'), tr('Again, for real this time!')],
  stalemate: [tr('Forget it 😅'), tr('A tie, then.')],
  watch: ['KKKKK', tr('Whoa!'), tr('Yikes!'), tr('Pay up!')],
};

export const MIRROR = {
  solo: ['Arrasei ✨', tr("I'm on fire today 😎"), tr('Hair on point ✅'), tr('Look approved ✨'), tr("This hair won't cooperate…"), tr('Ready for the next meeting ✨')],
  lipstick: [tr('Perfect lipstick 💄'), tr("Now we're talking 💋")],
  duo: [tr('Can I borrow your comb?'), tr('Looks great!'), tr('How do I look?'), tr("You're killing it!")],
};

export const CHAT = {
  fofoca: [tr("Did you see {nome}'s commit? 👀"), tr('Word is {sala} goes live today…'), tr("{nome}'s been stuck on the same bug for hours 🤫"), tr("I heard there's gonna be pizza 🍕"), tr('Did you know {nome} bets it all on rock-paper-scissors?')],
  work: [tr('My build passed on the first try 😎'), tr('This bug in {sala} is brutal'), tr('Deploy on a Friday? 😈'), tr('Who touched the package-lock?!'), tr('Tests are green ✅'), tr('Still waiting on the review…'), tr('Wrote 300 lines and deleted 400'), tr('Refactored all of {sala} today')],
  cafeina: [tr('This coffee is strong!'), tr('Fifth coffee already ☕'), tr('No coffee, no compile ☕')],
  piadas: [tr('Works on my machine! 😂'), tr('Why did the dev see a doctor? Too many bugs 🐛'), tr('There are 10 types of people… 😏'), tr('Commit: "final tweaks (for real this time)"'), tr('My code has no bugs, just surprise features')],
  esporte: [tr('Did you catch the game yesterday? ⚽'), tr('Wanna go running this weekend?')],
  series: [tr('Anyone see the latest episode? 📺'), tr('No spoilers, please!')],
  games: [tr('Beat that game yesterday 🎮'), tr('Wanna play online tonight?')],
  leitura: [tr("I'm reading a great book 📚"), tr('Finished that book!')],
  calma: [tr("Breathe… it'll all compile 🧘"), tr('One step at a time.')],
  apostas: [tr("Who's up for rock-paper-scissors later? 🎲"), tr('Feeling lucky today 🍀')],
  economia: [tr('Saving up 🪙 for vacation'), tr('Free coffee is the best coffee')],
  generic: [tr('Any weekend plans?'), tr('I need a vacation 🏖️'), tr('What a day, huh'), tr("It's been crazy busy today")],
  react: ['KKKKK', tr('Seriously?!'), tr("I can't believe it 😮"), tr('True!'), tr('Hahaha'), tr('Tell me about it…'), '👀', tr('Yep'), tr('No way!'), tr('Come on!')],
  laugh: ['KKKKK', tr('Hahaha!'), '😂😂😂'],
};

/** Leaving a gathering because work called. */
export const CALLED: Pool = [tr("Oops, they're calling me! 🏃"), tr("Gotta go! Work's here"), tr('Be right back!'), tr('Uh-oh, gotta go!')];
export const SHELL_DONE: Pool = [tr('My command finished! 🏃'), tr("Build's done, gotta go!")];

/** Chat topics that each trait pulls. */
export const TRAIT_TOPICS: Partial<Record<TraitId, keyof typeof CHAT>> = {
  fofoca: 'fofoca',
  cafeina: 'cafeina',
  piadas: 'piadas',
  esporte: 'esporte',
  series: 'series',
  games: 'games',
  leitura: 'leitura',
  calma: 'calma',
  apostas: 'apostas',
  economia: 'economia',
};

/** Line tied to local day/time, if any (Friday, Monday, morning, lunch, night). */
export function timeLine(d: Date): string | null {
  const day = d.getDay();
  const h = d.getHours();
  if (day === 5 && h >= 12) return tr('TGIF! 🎉');
  if (day === 1 && h < 12) return tr('Monday, huh…');
  if (h >= 6 && h < 10) return tr('Good morning! ☀️');
  if (h >= 11 && h < 14) return tr('So hungry… lunch? 🍽️');
  if (h >= 20 || h < 5) return tr('Still here at this hour? 🌙');
  return null;
}

export interface LineVars {
  nome?: string;
  sala?: string;
  v?: number | string;
  a?: number | string;
  b?: number | string;
}

/** Fills in speech fields. Without a value for a field, the speech is discarded (returns null). */
export function fill(line: string, vars: LineVars): string | null {
  let ok = true;
  const out = line.replace(/\{(nome|sala|v|a|b)\}/g, (_, k: keyof LineVars) => {
    const v = vars[k];
    if (v === undefined || v === '') {
      ok = false;
      return '';
    }
    return String(v);
  });
  return ok ? out : null;
}

/** Draws a speech from the pool (avoiding `avoid` and those that cannot be filled). */
export function pick(pool: Pool, rng: () => number, vars: LineVars = {}, avoid?: string | null): string {
  const n = pool.length;
  const start = Math.floor(rng() * n);
  let fallback: string | null = null;
  for (let i = 0; i < n; i++) {
    const s = fill(pool[(start + i) % n], vars);
    if (s === null) continue;
    if (s !== avoid) return s;
    fallback ??= s;
  }
  return fallback ?? pool.find((l) => !/\{\w+\}/.test(l)) ?? '…';
}
