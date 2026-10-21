// The UI fixture format: what the user saw in a whole conversation, turn by turn. Made by build/ui-fixtures.ts and
// replayed into the overlay by the gallery; later the native sheets read the same files.
import type { PageContext } from '../../contract/generated/types.ts';
import type { SurfaceEvent } from '../../testkit/src/fake-surface.ts';

export interface UiTurn {
  /** What the user typed. */
  message: string;
  page: PageContext;
  /** What came back, in order; the last is the answer or the error. */
  events: SurfaceEvent[];
}

export interface UiFixture {
  id: string;
  site: string;
  source: 'conversation' | 'reference';
  description: string;
  turns: UiTurn[];
}
