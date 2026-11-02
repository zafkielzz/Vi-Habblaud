// Lobby elevators: animated doors (states 0..4) that open while someone enters/exits.

/** Door speed: states per second (0 -> 4 in ~0.45 s). */
const DOOR_SPEED = 9;
/** Time the door stays open after the last use. */
const HOLD_MS = 650;
/** Interval between people exiting the same elevator. */
export const ELEVATOR_STAGGER_MS = 520;

export class Elevator {
  /** Continuous door opening, 0 (closed) .. 4 (open). */
  door = 0;
  private holdUntil = 0;
  private users = new Set<string>();
  /** Next free instant for someone to appear (arrival queue). */
  nextAppearAt = 0;

  constructor(
    readonly index: number,
    readonly spotId: string,
  ) {}

  request(id: string): void {
    this.users.add(id);
  }

  release(id: string, now: number): void {
    if (this.users.delete(id)) this.holdUntil = Math.max(this.holdUntil, now + HOLD_MS);
  }

  get load(): number {
    return this.users.size;
  }

  get isOpen(): boolean {
    return this.door >= 3.95;
  }

  get state(): number {
    return Math.max(0, Math.min(4, Math.round(this.door)));
  }

  update(dt: number, now: number): void {
    const want = this.users.size > 0 || now < this.holdUntil;
    this.door = Math.max(0, Math.min(4, this.door + (want ? 1 : -1) * DOOR_SPEED * dt));
  }

  /** Reserves a time slot to appear inside the elevator (staggering simultaneous arrivals). */
  reserveAppear(now: number): number {
    const at = Math.max(now, this.nextAppearAt);
    this.nextAppearAt = at + ELEVATOR_STAGGER_MS;
    return at;
  }

  reset(): void {
    this.users.clear();
    this.door = 0;
    this.holdUntil = 0;
    this.nextAppearAt = 0;
  }
}
