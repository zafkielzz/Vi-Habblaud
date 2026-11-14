// Help ("?"): the user guide, status and icon legend, controls, what the office shows, accounts and usage, and Codex.
import type { AgentStatus } from '../../../shared/types';
import type { HelpSection } from './context';
import { h, iconButton, prefersReducedMotion } from './dom';
import { ICONS } from './icons';
import { SHELL_STAGES, STATUS_LABEL } from './model';
import { CODEX_LIVE_HINT } from './provider';
import { createUsageSetup, richText } from './usage';
import { createAccountChip, updateAccountChip } from './widgets';
import { tr } from '../../../shared/i18n';

const STATUS_HELP: [AgentStatus, string][] = [
  ['working', tr('At the desk, typing: processing a request.')],
  ['waiting', tr('Hand raised: waiting for your answer in the terminal (permission, question or choice).')],
  ['shell', tr('Hourglass overhead: finished its turn and stays at the desk waiting for a shell to finish.')],
  ['idle', tr('Finished its turn and wanders around the office until the next instruction.')],
  ['done', tr('Subagent that finished: hands over the result and leaves.')],
  ['offline', tr('The session was closed: the character walks to the elevator and leaves.')],
];

const ICON_HELP: [string, string][] = [
  ['📨', tr('Got a request')],
  ['💭', tr('Thinking')],
  ['📖', tr('Reading a file')],
  ['🔎', tr('Searching the code')],
  ['✏️', tr('Editing')],
  ['📝', tr('Writing a file')],
  ['💻', tr('Terminal command')],
  ['⏳', tr('Waiting on a shell')],
  ['🧪', tr('Running tests')],
  ['🌐', tr('Searching the web')],
  ['🗒️', tr('Organizing tasks')],
  ['👥', tr('Calling subagents')],
  ['✋', tr('Needs you')],
  ['✅', tr('Done')],
  ['❌', tr('Shell failed')],
  ['🛑', tr('Shell interrupted')],
  ['⚠️', tr('Something went wrong')],
];

/** Social life gatherings (idle agents get together with coworkers). */
const SOCIAL_HELP: [string, string][] = [
  ['📺', tr('TV in the lounge: soccer (they cheer the goal along with the screen), soap opera or cartoons, with popcorn.')],
  ['🎮', tr('Video games on the couch (best of 3) or a duel at the arcade machines, with a cheering crowd.')],
  ['🏓', tr('Ping-pong to 5 points, with a scoreboard and fans behind the table.')],
  ['☕', tr('Chat in the kitchen: they grab coffee and sit down to gossip, tell jokes and talk shop.')],
  ['✊', tr('Rock-paper-scissors for coins: rock, paper, scissors, reveal, the winner takes the 🪙 (and the loser asks for a rematch).')],
  ['💄', tr('Bathroom mirror: they freshen up (lipstick, comb) and show up reflected in the glass.')],
  ['🪙', tr('Wallet: they arrive with 🪙100 (subagents 🪙30), earn 🪙10 per completed task, 🪙5 per handled request and 🪙15 per subagent delivery.')],
];

/** GitHub events observed live in sessions (gh, git push, GitHub MCP). */
const GITHUB_HELP: [string, string][] = [
  ['🎉', tr('Party: PR opened or merged, release published (or CI green after an alarm). Confetti falls in the room, everyone celebrates and a banner says why (~12 s).')],
  ['🚨', tr("Alarm: CI went red. Flashing beacons in the room's corners, a reddish floor and a “!” bubble over whoever saw the failure, until a green CI in the room (or 10 min).")],
  ['🚀', tr('Push: just the notice and the feed, nothing changes in the room.')],
];

/** Codex in the office: what differs from Claude Code (snippets `like this` become code). */
const CODEX_HELP: string[] = [
  tr('Each project open in Codex (in the terminal or the app) becomes a room: the same one as Claude Code for that folder, and the two share the room.'),
  tr('Codex agents have a hollow account chip (only the border in the account color) and the CODEX badge on the label and in the details.'),
  tr("{0} Without the hooks, the office reads Codex's session files: each step shows up when it finishes.", [CODEX_LIVE_HINT]),
  tr("Approving from the office: in Codex, the approval only shows up in the terminal after you answer here or the time runs out (a few seconds). There's no “don't ask again” or “interrupt”, and denying asks for a reason."),
  tr("Messages: they join the session queue and become the next prompt when Codex finishes what it's doing (up to ~10 s). With Habblaud in Docker, keep `npm run codex:bridge` running; in Node mode it works on its own."),
  tr('Codex questions are answered in Codex itself.'),
  tr("Usage: comes from Codex's session files, with nothing to install, and only refreshes while a session is running (that's why the card shows its age, e.g. “12 min ago”). “no quota” means no quota or credits to use right now."),
  tr("My day: Codex counts tokens but doesn't record cost."),
];

/** End of waiting (the server marks with a ✅ or ❌ activity). */
const SHELL_END_HELP: [string, string][] = [
  ['🎉', tr('Finished well: stands up, celebrates with confetti and a star.')],
  ['🌧️', tr('Failed or was interrupted: a little rain cloud overhead and slumped shoulders.')],
];

const INTRO =
  tr('Each project open in Claude Code or Codex becomes a room (both on the same project share the room), and each open session is a character with its own name. ') +
  tr("Subagents arrive as new coworkers, work in the same room and leave when they're done. ") +
  tr("When a room's last session closes, whoever leaves turns off the light and the room is taken down.");

const SHORTCUTS: [string[], string][] = [
  [['/'], tr('Search for an agent, project or account')],
  [['F'], tr('Follow the selected agent')],
  [['T'], tr("Open or close the selected agent's terminal")],
  [['Ctrl+F'], tr('With the terminal focused: search the conversation (⌘F on Mac); Enter and Shift+Enter navigate')],
  [['L'], tr("Open or close the day's timelapse")],
  [['P'], tr('Go to the next permission request or question to answer from the office')],
  [['M'], tr('My day: where the time went (working, waiting on you...)')],
  [['B'], tr("Board: tasks (todo and handoff), jobs given to the workers, today's news; 1 2 3 switch tabs")],
  [['R'], tr('Rules of the office shown: scope, rules, limits, the boss\'s proposals and what was refused')],
  [['H'], tr('Boss overloaded: sessions with a long context, ask for a handoff and open a new session')],
  [['O', '0'], tr('Building overview')],
  [['Esc'], tr('Close the terminal search, then the terminal; then the details panel and the selection')],
  [['['], tr('Show or hide the sidebar')],
  [[']'], tr('Show or hide the activity feed')],
  [['?'], tr('Open this help')],
  [['Alt'], tr('Hold it: notes on every button and area on screen say what it does')],
  [['←', '↑', '→', '↓'], tr('Move the camera (also W A S D)')],
  [['+', '−'], tr('Zoom in and out')],
];

/** The guide to working with the office, topic by topic. Keep it true to the page: a changed feature changes its topic. */
const GUIDE: [string, string[]][] = [
  [tr('🚀 Start and stop'), [
    tr('Run npm run office in the project folder, then open http://127.0.0.1:4747. Reload the page after an update.'),
    tr('The server keeps running when you close the terminal, but not after a reboot: run the command again then.'),
    tr('Stopping the server also ends the sessions in the terminals on this page. Sessions you opened in your own terminal keep running.'),
  ]],
  [tr('🏢 Offices'), [
    tr('An office is one team for one project folder, shown as its own building. Press ＋ on the tab strip to make one.'),
    tr('To rename it, change its folder or delete it: ⋯ at the end of the strip, double-click its tab, or right-click it.'),
    tr('Two offices cannot share a folder, but one may sit inside another: a session belongs to the deepest office folder holding it.'),
    tr('An office lasts as long as its boss\'s session: it closes when the session ends and comes back when you resume it (claude --resume). In a terminal, /offices lists them.'),
    tr('Switching tabs closes the terminal and details of the office you left; its sessions keep running.'),
  ]],
  [tr('👑 The boss'), [
    tr('＋ next to Boss opens a Claude Code session in the office folder and makes it the boss. You talk to it in its terminal.'),
    tr('You can also pick a session you already have: open its details and press 👑 Make boss, or type /boss in that session\'s terminal.'),
    tr('The boss plans, gives jobs to the workers and checks the results.'),
    tr('In a folder without a HANDOFF file, the boss asks whether to create one before it starts.'),
  ]],
  [tr('🧑‍🔧 Workers'), [
    tr('＋ next to Workers has two lists. "Add an account" takes an Antigravity or Claude Code account that is not in the office yet. Accounts must be signed in first.'),
    tr('Every job is a new conversation: a worker does not remember the job before it.'),
    tr("A worker's terminal is read-only: open its details and press 👁 Watch its terminal."),
    tr('A worker can serve several offices. It then has a character in each, named "(2)", and a busy worker refuses new jobs.'),
    tr('"Clone a session" gives one more session ("#2", "#3"…) of an account already in the office, or of the boss\'s own Claude account: its own terminal, working side by side on the same quota.'),
    tr('In the boss\'s terminal: /workers add acc3 (a new account), /workers clone claude 3 (three more sessions), /workers rm acc3#2 (one session) or /workers rm acc3 (the account with all its sessions). /office lists every command.'),
  ]],
  [tr('📨 Giving work'), [
    tr('Directly: type in the boss\'s terminal, or send a message from its details. It starts right away.'),
    tr('On the to-do list: add a task on the Board. It waits in the HANDOFF file and does not wake the boss.'),
    tr('▶ Continue the to-do on the Board tells the boss to read the list and do the next open task, one at a time.'),
    tr('To a worker: Send a job in its details, without going through the boss.'),
  ]],
  [tr('📋 The Board (B)'), [
    tr("The to-do list is the \"Next steps\" list of the office's HANDOFF file: the boss and you edit the same list."),
    tr("The workers' jobs are this office's only, with their tokens and cache. A job from anywhere else is not listed."),
    tr('The news shows failed jobs, quota hits, hung workers, rule refusals and who needs you.'),
  ]],
  [tr('📜 Office rules (R)'), [
    tr('Each office sets where its agents may edit, what they may never read, which commands are forbidden, and job and quota limits.'),
    tr('The office folder limits the workers: a worker is refused outside it, the boss is not. Forbidden paths and commands hold for everyone.'),
    tr('This stops mistakes, not a determined script: a program the agent writes itself can still get around it.'),
    tr('A boss can only propose a rule; you accept it here. A refusal shows on the Board.'),
  ]],
  [tr('🥵 A tired boss (H)'), [
    tr('A long context or repeated compactions make a session slow and forgetful. A notice tells you when a boss passes a limit.'),
    tr('Click the notice, press Ask for a handoff so it writes down its progress, then New session here to carry on.'),
    tr('Set the limits in Settings › Boss overloaded.'),
  ]],
  [tr('☕ Reading the characters'), [
    tr('The mug on the desk empties with the 5-hour quota. A character with no quota left sleeps at its desk until it renews.'),
    tr('A worker silent for 10 minutes fades into a ghost 👻: it may be hung. Nothing is stopped for you.'),
    tr('Hold Alt to see what every button does.'),
  ]],
];

function keys(list: string[]): HTMLElement {
  return h('span', { class: 'ui-keys' }, ...list.map((k) => h('kbd', { class: 'ui-kbd', text: k })));
}

export class HelpDialog {
  readonly el: HTMLDialogElement;
  private sections = new Map<HelpSection, HTMLElement>();

  /** `showHints`: the "hold Alt" notes, for a button here (screens without a keyboard). */
  constructor(showHints?: () => void) {
    const close = iconButton(ICONS.close, tr('Close help'), () => this.el.close(), 'ui-icon-btn--sm');
    const hintsBtn = showHints
      ? h('button', {
          class: 'ui-btn ui-btn--sm',
          type: 'button',
          text: tr('👀 What does each button do?'),
          attrs: { 'data-hint': tr('Shows these notes; holding Alt does the same. Tap anywhere to hide them.') },
          on: {
            click: () => {
              this.el.close();
              // after the click that opened it, or that click's pointerdown would hide it right away
              setTimeout(showHints, 0);
            },
          },
        })
      : null;
    const statusList = h(
      'ul',
      { class: 'ui-legend' },
      ...STATUS_HELP.map(([s, text]) =>
        h('li', {}, h('span', { class: `ui-status-dot is-${s}`, attrs: { 'aria-hidden': 'true' } }), h('strong', { text: STATUS_LABEL[s] }), h('span', { text })),
      ),
    );
    const iconList = h(
      'ul',
      { class: 'ui-icon-legend' },
      ...ICON_HELP.map(([icon, text]) => h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: icon, attrs: { 'aria-hidden': 'true' } }), h('span', { text }))),
    );
    const shortcuts = h('dl', { class: 'ui-shortcuts' }, ...SHORTCUTS.flatMap(([k, text]) => [h('dt', {}, keys(k)), h('dd', { text })]));

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-help', attrs: { 'aria-labelledby': 'ui-help-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: tr('How to read the office'), attrs: { id: 'ui-help-title' } }), close),
      h(
        'div',
        { class: 'ui-dialog__body' },
        h('section', { class: 'ui-help__intro' }, h('p', { text: INTRO }), hintsBtn),
        this.guideSection(),
        h('section', {}, h('h3', { text: 'Status' }), statusList),
        h('section', {}, h('h3', { text: tr('Activities') }), iconList),
        this.shellSection(),
        this.socialSection(),
        this.githubSection(),
        h(
          'section',
          {},
          h('h3', { text: tr('Controls') }),
          h(
            'ul',
            { class: 'ui-help__list' },
            h('li', { text: tr('Drag the office to move the camera and use the mouse wheel (or pinch) to zoom.') }),
            h('li', { text: tr('Click a character or room to see its details; double-click zooms the camera in.') }),
            h('li', { text: tr("Hover over a character to see what they're doing.") }),
            h('li', {
              text: tr("In an agent's details, “Open terminal” shows the session's conversation as in Claude Code (or Codex), live (requires local access, bind 127.0.0.1)."),
            }),
            h('li', {
              text: tr('With the habblaud-mensagens plugin (npm run mod:install), you can send messages to the main agent from its details or from the box at the bottom of the terminal: the text enters the session as if you had typed it. Enter sends, Shift+Enter adds a line break.'),
            }),
            h('li', {
              text: tr('In the terminal: search (magnifier or Ctrl/⌘+F), the “All / Prompts only / No tools” filter and a copy button on each entry. The clock in the top bar opens the history of sessions from the last 7 days, including ended ones.'),
            }),
            h('li', {
              text: tr('With the Habblaud mod installed (npm run mod:install, which includes the permissions plugin), an agent that “asks for permission” shows the command or edit in its details, along with the Approve, Deny and Answer in terminal buttons; an agent that asks a question shows the options (and an “Other” to write your own) so you can answer from here. The dialog stays open in the terminal: whichever answer comes first wins.'),
            }),
          ),
          shortcuts,
        ),
        this.usageSection(),
        this.codexSection(),
      ),
    );
    // Click on background (outside content) closes dialog.
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.el.close();
    });
  }

  open(section?: HelpSection): void {
    if (!this.el.open) this.el.showModal();
    const target = section ? this.sections.get(section) : undefined;
    if (!target) return;
    // Scroll to requested section and briefly highlight it.
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      target.classList.remove('is-highlight');
      void target.offsetWidth;
      target.classList.add('is-highlight');
      const heading = target.querySelector<HTMLElement>('h3');
      heading?.focus({ preventScroll: true });
    });
  }

  /** The guide: one folded topic each, so it reads as a handbook, not a wall of text. */
  private guideSection(): HTMLElement {
    return h(
      'section',
      { class: 'ui-help__guide' },
      h('h3', { text: tr('📖 User guide') }),
      ...GUIDE.map(([title, lines]) => h('details', {}, h('summary', { text: title }), h('ul', { class: 'ui-help__list' }, ...lines.map((text) => h('li', { text }))))),
    );
  }

  /** Shell wait legend: the character's "comic escalation" as the shell drags on. */
  private shellSection(): HTMLElement {
    const item = (emoji: string, text: string) =>
      h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { text }));
    return h(
      'section',
      { class: 'ui-help__shell' },
      h('h3', { text: tr('Waiting on shell') }),
      h('p', {
        class: 'ui-help__lead',
        text:
          tr("When the agent ends its turn with a command running in the background (or sits on a command for more than 10 s), it doesn't wander off: ") +
          tr("it stays at its desk with the hourglass turning, the monitor shows the progress and a bubble says which shell it's waiting on and for how long. The longer it takes…"),
      }),
      h('ul', { class: 'ui-shell-legend' }, ...SHELL_STAGES.map((s) => item(s.emoji, s.help)), ...SHELL_END_HELP.map(([e, t]) => item(e, t))),
    );
  }

  /** Social life legend: gatherings of idle agents, personalities, and coins. */
  private socialSection(): HTMLElement {
    const item = (emoji: string, text: string) =>
      h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { text }));
    return h(
      'section',
      { class: 'ui-help__shell' },
      h('h3', { text: tr('Social life') }),
      h('p', {
        class: 'ui-help__lead',
        text:
          tr('When two or more agents have nothing to do (idle, or waiting on a shell for more than 40 s), they get together. Each one has 2 or 3 personality traits ') +
          tr("(competition, gossip, vanity, naps…), friendships and rivalries, and that decides what they'd rather do, with whom and what they talk about. ") +
          tr("The agent's details show its personality, wallet and statement; matches and bets show up in the feed."),
      }),
      h('ul', { class: 'ui-shell-legend' }, ...SOCIAL_HELP.map(([e, t]) => item(e, t))),
    );
  }

  /** GitHub office legend: celebrations and alarms in rooms. */
  private githubSection(): HTMLElement {
    const item = (emoji: string, text: string) =>
      h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { text }));
    return h(
      'section',
      { class: 'ui-help__shell' },
      h('h3', { text: tr('GitHub in the office') }),
      h('p', {
        class: 'ui-help__lead',
        text:
          tr('What agents do on GitHub (gh pr create/merge, git push, gh run watch, gh pr checks, gh release create and the GitHub MCP) becomes a notice, ') +
          tr("goes into the feed and livens up the project's room. Only what happens live: anything already in the transcripts when Habblaud opened stays in the history only."),
      }),
      h('ul', { class: 'ui-shell-legend' }, ...GITHUB_HELP.map(([e, t]) => item(e, t))),
    );
  }

  private usageSection(): HTMLElement {
    const el = h(
      'section',
      { class: 'ui-help__usage', attrs: { 'aria-labelledby': 'ui-help-usage' } },
      h('h3', { text: tr('Accounts and usage'), tabIndex: -1, attrs: { id: 'ui-help-usage' } }),
      h(
        'ul',
        { class: 'ui-help__list' },
        h('li', { text: tr('The colored chip with the letter (C, D…) shows which Claude Code account each agent belongs to: each terminal shortcut uses a different config folder.') }),
        h('li', {}, accountSample('C', '#f08a3c'), tr(' Claude Code account · '), accountSample('X', '#a77bf3', true), tr(" Codex account (outlined chip, with the CODEX badge where there's room).")),
        h('li', {
          text: tr("At the top, each account shows its 5-hour session and weekly usage. The ↻ shows when each limit resets (a countdown if it's less than a day away). Green below 50%, amber up to 80% and red beyond that."),
        }),
        h('li', { text: tr('Old numbers are grayed out with their age next to them (e.g. “3 h ago”); a window that has reset since the reading shows “—” and “renewed”.') }),
      ),
      h('p', { class: 'ui-help__lead', text: tr("To see an account's usage (“no usage data”), in order of preference:") }),
      createUsageSetup(),
    );
    this.sections.set('usage', el);
    return el;
  }

  /** Codex in the office ("How it works" on a Codex account's usage card opens here). */
  private codexSection(): HTMLElement {
    const el = h(
      'section',
      { class: 'ui-help__usage', attrs: { 'aria-labelledby': 'ui-help-codex' } },
      h('h3', { text: 'Codex', tabIndex: -1, attrs: { id: 'ui-help-codex' } }),
      h('ul', { class: 'ui-help__list' }, ...CODEX_HELP.map((text) => h('li', {}, ...richText(text)))),
    );
    this.sections.set('codex', el);
    return el;
  }

  get isOpen(): boolean {
    return this.el.open;
  }
}

/** An example account chip (legend). */
function accountSample(short: string, color: string, codex = false): HTMLElement {
  const chip = createAccountChip('sm');
  updateAccountChip(chip, { id: short, short, name: codex ? 'Codex' : tr('Account {0}', [short]), color, configDir: '', sessions: 0, usageStatus: 'disabled', ...(codex ? { provider: 'codex' as const } : {}) });
  chip.setAttribute('aria-hidden', 'true');
  return chip;
}
