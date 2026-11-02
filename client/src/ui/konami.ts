// Easter egg: ↑ ↑ ↓ ↓ ← → ← → B A anywhere on the page (outside text inputs) triggers a party in all rooms
// (POST /api/fun/party; local machine only). Pure in the key-counting logic (konamiStep).
const CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

/** Next sequence step with key `key` (current step is `at`); returns CODE.length when complete. */
export function konamiStep(at: number, key: string): number {
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (k === CODE[at]) return at + 1;
  return k === CODE[0] ? 1 : 0;
}

/** `midCode()`: the arrows are done and B is next (the B shortcut then stays out of the way). */
export function attachKonami(onCode: () => void): { detach: () => void; midCode: () => boolean } {
  let at = 0;
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    at = konamiStep(at, e.key);
    if (at === CODE.length) {
      at = 0;
      onCode();
    }
  };
  addEventListener('keydown', onKey);
  return { detach: () => removeEventListener('keydown', onKey), midCode: () => at === CODE.indexOf('b') };
}
