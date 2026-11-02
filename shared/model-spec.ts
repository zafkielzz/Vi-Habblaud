// Model and reasoning effort of an agent, written short for people: the drawer, the office list and the name tag on
// the floor ("Opus 5.5 · high", "Flash 3.8 · low"). Claude Code reports them in the transcript; Antigravity workers in
// the agy log (server/sources/agy/clilog.ts).

/** Model id as people say it: "claude-opus-5-5" -> "Opus 5.5", "gpt-5.3-codex" -> "GPT-5.3 Codex", "gemini-3.8-flash-low" -> "Gemini 3.8 Flash". */
export function prettyModel(model: string | undefined): string {
  if (!model) return '—';
  const gemini = /^gemini-(\d+(?:\.\d+)?)-([a-z]+)/i.exec(model);
  if (gemini) return `Gemini ${gemini[1]} ${gemini[2].charAt(0).toUpperCase()}${gemini[2].slice(1).toLowerCase()}`;
  // Codex: "gpt-5.3-codex" -> "GPT-5.3 Codex", "gpt-5.1-codex-mini" -> "GPT-5.1 Codex Mini", "gpt-5" -> "GPT-5".
  const gpt = /^gpt-(\d+(?:\.\d+)?[a-z]?)((?:-[a-z][a-z0-9]*)*)$/i.exec(model);
  if (gpt) {
    const words = gpt[2]
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    return [`GPT-${gpt[1]}`, ...words].join(' ');
  }
  // Formats: "claude-opus-5-5", "claude-sonnet-4-5-20250929", "claude-opus-4-20250514", "claude-3-5-sonnet-20241022".
  const m = /claude-(?:(\d{1,2}(?:-\d{1,2})?)-)?([a-z]+)(?:-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?)?/i.exec(model);
  if (!m) return model;
  const family = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
  const version = m[1] ? m[1].replace('-', '.') : m[3] ? (m[4] ? `${m[3]}.${m[4]}` : m[3]) : '';
  return version ? `${family} ${version}` : family;
}

/** Short form for the name tag and lists: model ("Gemini 3.8 Flash" -> "Flash 3.8") and effort, "" when unknown. */
export function modelSpec(a: { model?: string; effort?: string }): string {
  const pretty = a.model ? prettyModel(a.model).replace(/^Gemini (\S+) (\S+)$/, '$2 $1') : '';
  return [pretty, a.effort].filter(Boolean).join(' · ');
}
