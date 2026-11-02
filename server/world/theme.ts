// Building theme in World: the choice in Settings › Appearance (world.json) resolved for the packet payload.
// Automatic follows the office calendar (seasonalThemeFor, client/src/world/api.ts; a test ensures they don't
// drift): Halloween from October 1 to 31, Christmas from November 1 to December 26, and none for the rest of the year.
// The date is the server local time (in Docker, UTC).
import type { WorldThemeChoice } from '../../shared/world/api';
import type { WorldTheme } from '../../shared/world/protocol';

export function resolveWorldTheme(choice: WorldThemeChoice | undefined, date: Date): WorldTheme {
  if (choice && choice !== 'auto') return choice;
  const month = date.getMonth();
  if (month === 9) return 'halloween';
  if (month === 10 || (month === 11 && date.getDate() <= 26)) return 'christmas';
  return 'none';
}
