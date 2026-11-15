// The stand-ins for card-only values (sign-in mode, contract/src/privacy.ts): one session's table of withheld:<n> for
// each private value the model was given a stand-in for. Owned by the Session, saved with its snapshot, and never
// sent anywhere: it's the only place the real values and their stand-ins meet. Outgoing results get stand-ins
// (alias), incoming calls get the real values back (resolve), and text the brain will see, such as a pressed card's
// title or the page's address, has any real value in it replaced (hide).
import { isWithheld } from '../../../contract/src/privacy.ts';

type Value = string | number;

/** Shorter values aren't hidden inside text: they'd match ordinary words and numbers. */
const MIN_HIDDEN_LENGTH = 4;

export class Withheld {
  private aliases = new Map<string, string>();
  private values = new Map<string, Value>();

  /** The stand-in for a value; the same value always gets the same one. */
  alias(value: Value): string {
    const key = typeof value === 'number' ? `n:${value}` : `s:${value}`;
    let stand = this.aliases.get(key);
    if (!stand) {
      stand = `withheld:${this.values.size + 1}`;
      this.aliases.set(key, stand);
      this.values.set(stand, value);
    }
    return stand;
  }

  /** The value with every stand-in this session issued swapped back, at any depth; an unknown stand-in stays as it is. */
  resolve<T>(value: T): T {
    const swap = (node: unknown): unknown => {
      if (isWithheld(node)) return this.values.has(node) ? this.values.get(node) : node;
      if (Array.isArray(node)) return node.map(swap);
      if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, swap(child)]));
      return node;
    };
    return swap(value) as T;
  }

  /** The text with every withheld value in it replaced by its stand-in, longest first so one can't hide part of another. */
  hide(text: string): string {
    const hidden = [...this.values.entries()].map(([stand, value]) => [stand, String(value)] as const).filter(([, value]) => value.length >= MIN_HIDDEN_LENGTH).sort((left, right) => right[1].length - left[1].length);
    return hidden.reduce((result, [stand, value]) => result.split(value).join(stand), text);
  }

  get size(): number {
    return this.values.size;
  }

  /** Every stand-in with its value, for a saved session. */
  entries(): [string, Value][] {
    return [...this.values.entries()];
  }

  /** Puts back what entries() saved, so stand-ins the model already holds keep meaning the same values. */
  restore(entries: readonly [string, Value][]): void {
    for (const [stand, value] of entries) {
      if (!isWithheld(stand) || (typeof value !== 'string' && typeof value !== 'number')) continue;
      this.values.set(stand, value);
      this.aliases.set(typeof value === 'number' ? `n:${value}` : `s:${value}`, stand);
    }
  }
}
