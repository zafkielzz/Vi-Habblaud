# How to contribute

Thanks for wanting to contribute to Habblaud! Bug reports, ideas, and improvements are welcome.

## Before starting

- For bugs and ideas, check the [issues](https://github.com/marmottajr/habblaud/issues) to see if the topic was
  already reported.
- For larger changes or those changing Habblaud's behavior, open an issue to discuss the proposal before implementing.
- Prefer small, focused changes. If the change modifies what appears or happens in the office, describe that
  behavior in the pull request.

## Setting up the environment

Habblaud requires Node.js 22.12 or newer and npm. After cloning the repository:

```sh
npm install
npm run dev
```

The development office is at <http://localhost:4747>.

## Texts and translations

Habblaud's interface is in English and Vietnamese. English is the source language:

- Every text users see (interface, errors, logs, install scripts) is written in English inside `tr()`
  (`shared/i18n.ts`). Values go in numbered placeholders: `tr('Reading {0}', [file])`, never a template string inside
  `tr()`.
- The translation key is the English text itself: changing the text changes the key. Update its Vietnamese translation
  in `shared/locales/vi.ts`, or leave it out: an untranslated text shows up in English.
- `npm run i18n:check` lists untranslated texts and leftover translations.

## Verifying a change

Before opening a pull request, run:

```sh
npm run typecheck
npm test
npm run build
```

If the change affects a Claude Code plugin, also validate the affected plugin:

```sh
claude plugin validate mod/habblaud
claude plugin test mod/habblaud
```

Use the path of the modified plugin (`mod/habblaud-permissoes` or `mod/habblaud-mensagens`) when applicable.

## Opening a pull request

- Use a clear title and explain the problem, the change, and how it was verified.
- Reference the related issue, if any.
- For visual changes, include a screenshot or GIF if helpful to demonstrate results. Take screenshots in
  demo mode (`?mock=1` in URL or `npm run demo`), which only shows fictional agents.
- Update the **Unreleased** section of `CHANGELOG.md` when the change introduces something visible to Habblaud users.
- PRs touching `shared/world/` or `server/world/` (Habblaud World) explain what changes in what leaves the machine, and
  review cross-checks the [`docs/world/privacidade.md`](docs/world/privacidade.md) list against the code. Read
  [`shared/world/README.md`](shared/world/README.md) first.
- Do not include personal data, credentials, or private session content in screenshots, examples, or logs.

If anything is unclear, ask in the related issue before heading in a direction that might change project behavior.
