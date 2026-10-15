// FakeSurface: a headless surface that records what the user would see: progress lines, early results, answers and
// errors. It stands in for the overlay and the native sheets, so Intake and Respond can be tested with no UI.
import type { Surface } from '../../core/src/link.ts';
import type { UiComponent } from '../../core/src/present.ts';

export type SurfaceEvent =
  | { type: 'progress'; text: string }
  | { type: 'early'; components: UiComponent[] }
  | { type: 'answer'; text: string; components: UiComponent[]; budgetReached: boolean }
  | { type: 'error'; message: string };

export class FakeSurface implements Surface {
  readonly events: SurfaceEvent[] = [];

  progress(text: string): void {
    this.events.push({ type: 'progress', text });
  }

  early(components: UiComponent[]): void {
    this.events.push({ type: 'early', components });
  }

  answer(text: string, components: UiComponent[], meta: { budgetReached: boolean }): void {
    this.events.push({ type: 'answer', text, components, budgetReached: meta.budgetReached });
  }

  error(message: string): void {
    this.events.push({ type: 'error', message });
  }

  get answers() {
    return this.events.filter((e): e is Extract<SurfaceEvent, { type: 'answer' }> => e.type === 'answer');
  }

  get errors() {
    return this.events.filter((e): e is Extract<SurfaceEvent, { type: 'error' }> => e.type === 'error');
  }
}
