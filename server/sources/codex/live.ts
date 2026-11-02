// Codex hook events (the "live" part of the Codex source): the hook script sends the event stdin to
// POST /api/codex/events and the route forwards it here. The Codex source (sources/codex/source.ts) implements it.

export interface CodexLive {
  /**
   * Applies a Codex hook event (its stdin: `hook_event_name`, `session_id`, `agent_id`, `cwd`,
   * `tool_name`, `tool_use_id`, `tool_input`, `transcript_path`...) to the office. `account` = Codex account
   * of the sender (account id or CODEX_HOME path; absent = deduced from `transcript_path` or thread). Returns
   * false for unknown event or session that does not match any Codex account.
   */
  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean;
}
