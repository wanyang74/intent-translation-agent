// The UI fixture gallery, in the browser: replays saved surface events into real overlays, one per fixture, so the
// overlay can be looked at and screenshot-tested with no brain, model or site. The build (build/gallery.ts) puts the
// fixtures in `window.uiFixtures`. With a #<fixture id> in the URL, only that fixture is drawn, for its screenshot.
// With ?floating, overlays float over the page as on a site, so they can be moved, resized and folded; ?placement=<JSON>
// starts them where a host would have kept them.
import type { PanelPress } from '../../contract/generated/types.ts';
import type { UiFixture } from './ui-fixture.ts';
import { element } from './render.ts';
import { Overlay } from './overlay.ts';
import { placementOf, type PanelPlacement } from './placement.ts';

declare global {
  interface Window {
    uiFixtures: UiFixture[];
    /** What the user sent from any overlay (a picked option, a submitted form), with the fixture it came from. */
    sent: { fixture: string; message: string }[];
    /** The pages a Take me there button would have opened, with any page action and the press; the gallery never navigates. */
    navigated: { fixture: string; url: string; action?: string; press: PanelPress }[];
    /** Cards' links opened in a new tab, by their press. */
    pressed: { fixture: string; press: PanelPress }[];
    /** Each site pack's brand color, by site id (build/gallery.ts). */
    brandColors: Record<string, string>;
    /** Every placement a floating overlay reported, in order. */
    placements: PanelPlacement[];
    /** Fixtures whose account button was pressed. */
    allowed: string[];
  }
}

window.sent = [];
window.navigated = [];
window.pressed = [];
window.placements = [];
window.allowed = [];
const query = new URLSearchParams(location.search);
const floating = query.has('floating');
const startPlacement = (() => {
  try {
    return placementOf(JSON.parse(query.get('placement') ?? 'null'));
  } catch {
    return null;
  }
})();

/** Plays one fixture into a fresh overlay: each message, then exactly the events the surface received. */
function replay(fixture: UiFixture, mountPoint: HTMLElement): void {
  const onSend = (message: string) => window.sent.push({ fixture: fixture.id, message });
  const onNavigate = (url: string, focus: { action: string } | undefined, press: PanelPress) => window.navigated.push({ fixture: fixture.id, url, ...(focus ? { action: focus.action } : {}), press });
  const onPress = (press: PanelPress) => window.pressed.push({ fixture: fixture.id, press });
  const onAllowAccount = () => window.allowed.push(fixture.id);
  const brandColor = window.brandColors[fixture.site];
  const layout = floating ? { startOpen: true, placement: startPlacement, onPlacement: (placement: PanelPlacement) => window.placements.push(placement) } : { staticLayout: true };
  const overlay = new Overlay(document, mountPoint, { title: `Ask ${fixture.site}`, siteName: fixture.site, ...layout, onSend, onNavigate, onPress, onAllowAccount, ...(brandColor ? { brandColor } : {}) });
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
