// The UI fixture gallery, in the browser: replays saved surface events into real overlays, one per fixture, so the
// overlay can be looked at and screenshot-tested with no brain, model or site. The build (build/gallery.ts) puts the
// fixtures in `window.uiFixtures`. With a #<fixture id> in the URL, only that fixture is drawn, for its screenshot.
import type { UiFixture } from './ui-fixture.ts';
import { element } from './render.ts';
import { Overlay } from './overlay.ts';

declare global {
  interface Window {
    uiFixtures: UiFixture[];
    /** What the user sent from any overlay (a picked option, a submitted form), with the fixture it came from. */
    sent: { fixture: string; message: string }[];
  }
}

window.sent = [];

/** Plays one fixture into a fresh overlay: each message, then exactly the events the surface received. */
function replay(fixture: UiFixture, mountPoint: HTMLElement): void {
  const onSend = (message: string) => window.sent.push({ fixture: fixture.id, message });
  const overlay = new Overlay(document, mountPoint, { title: `Ask ${fixture.site}`, staticLayout: true, onSend });
  for (const turn of fixture.turns) {
    overlay.userMessage(turn.message);
    for (const event of turn.events) {
      if (event.type === 'progress') overlay.progress(event.text);
      else if (event.type === 'early') overlay.early(event.components);
      else if (event.type === 'answer') overlay.answer(event.text, event.components, { budgetReached: event.budgetReached });
      else overlay.error(event.message);
    }
  }
}

const only = decodeURIComponent(location.hash.slice(1));
const shown = only ? window.uiFixtures.filter((fixture) => fixture.id === only) : window.uiFixtures;
const grid = element(document, 'main', 'grid');
for (const fixture of shown) {
  const mountPoint = element(document, 'div', 'overlay');
  mountPoint.dataset.fixture = fixture.id;
  grid.append(element(document, 'section', 'fixture', [
    only ? null : element(document, 'h2', undefined, [fixture.id]),
    only ? null : element(document, 'p', undefined, [`${fixture.source} · ${fixture.description}`]),
    mountPoint,
  ]));
  replay(fixture, mountPoint);
}
document.body.append(grid);
