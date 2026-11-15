// The overlay: the web surface, a chat panel on the right of the site's page. It implements core.js's Surface, so
// Brain link drives it the same way it drives FakeSurface in tests and the native sheets later. It draws what it's
// told and reports what the user typed; deciding whether a message starts a turn or amends one is the controller's
// job (agent.ts). Everything lives in a shadow root, apart from the site's DOM and CSS. It keeps a record of what it
// has shown (shown()), so the next page of the site can draw the same conversation again (restore()). A button to
// the site leaves a quiet line saying what was pressed, the same press the model hears with the next message. The
// panel can be dragged by its header, resized from its left and top edges and bottom-left corner, and folded down to
// its header, so the user can see the page under it; it reports where it is (onPlacement) for the host to keep, and
// placement.ts keeps it inside the window.
import type { PanelPress } from '../../contract/generated/types.ts';
import type { Surface } from '../../core/src/link/link.ts';
import type { PageFocus, UiComponent } from '../../core/src/present/present.ts';
import { pressText, type ShownEntry } from './conversation.ts';
import { fitBox, movedBox, resizedBox, type PanelBox, type PanelPlacement, type ResizeEdge, type Viewport } from './placement.ts';
import { element, renderComponent, renderText, type ComponentActions } from './render.ts';
import { OVERLAY_CSS } from './styles.ts';

export interface OverlayOptions {
  /** The panel's title, such as "Ask <site name>". */
  title: string;
  /** Shown in an empty conversation. */
  greeting?: string;
  /** The user sent a message: typed, an option picked, or a form submitted. */
  onSend(message: string): void;
  /** The site's name, for the line a pressed button leaves in the conversation. */
  siteName?: string;
  /** The site pack's brand color (#rrggbb), for the buttons and the user's messages; checked again here, since it goes into CSS. */
  brandColor?: string;
  /**
   * The user tapped Take me there, or a card's button to the page that shows it; `press` says which. Without it, the
   * page opens in the same tab.
   */
  onNavigate?(url: string, focus: PageFocus | undefined, press: PanelPress): void;
  /** The user opened the site in a new tab from a card's link. */
  onPress?(press: PanelPress): void;
  /** Where the user last left the panel, on this site; it's fitted to this window. */
  placement?: PanelPlacement | null;
  /** The user moved, resized, folded or reset the panel. */
  onPlacement?(placement: PanelPlacement): void;
  /** Drawn in the page's flow at its full height instead of floating: for the UI fixture gallery and screenshots. */
  staticLayout?: boolean;
  /** Opened at once instead of behind the launcher button. */
  startOpen?: boolean;
}

export class Overlay implements Surface {
  private readonly doc: Document;
  private readonly options: OverlayOptions;
  private readonly panel: HTMLElement;
  private readonly launcher: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly actions: ComponentActions;
  /** The agent's reply to the latest message, while it's being written; progress lines and early results go here. */
  private reply: { box: HTMLElement; progress: HTMLElement | null } | null = null;
  /** What has been shown, in order: the user's messages and every finished part of a reply (progress lines aren't kept). */
  private history: ShownEntry[] = [];
  /** The box the user dragged or resized the panel to; null while it sits in its default place. */
  private box: PanelBox | null = null;
  /** Whether the panel is folded down to its header. */
  private folded = false;
  private readonly foldButton: HTMLElement;

  /** Draws the overlay inside a shadow root on `mountPoint`. */
  constructor(doc: Document, mountPoint: HTMLElement, options: OverlayOptions) {
    this.doc = doc;
    this.options = options;
    // A press is drawn first, so the conversation saved before the page changes already shows it.
    this.actions = {
      send: (message) => this.send(message),
      navigate: (url, focus, press) => {
        this.pressed(press);
        if (options.onNavigate) options.onNavigate(url, focus, press);
        else doc.defaultView?.location.assign(url);
      },
      press: (press) => {
        this.pressed(press);
        options.onPress?.(press);
      },
    };
    const root = mountPoint.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = OVERLAY_CSS;

    this.log = element(doc, 'div', 'log', [element(doc, 'div', 'empty', [options.greeting ?? 'Tell me what you’re looking for.'])]);
    this.input = doc.createElement('textarea');
    this.input.placeholder = 'Ask anything…';
    this.input.rows = 1;
    this.input.addEventListener('keydown', (event) => {
      // Enter sends; Shift+Enter starts a new line. isComposing skips the Enter that confirms an IME composition.
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      const message = this.input.value.trim();
      if (!message) return;
      this.input.value = '';
      this.send(message);
    });
    this.foldButton = element(doc, 'button', 'icon-btn fold', ['–']);
    this.foldButton.setAttribute('aria-label', 'Minimize');
    this.foldButton.addEventListener('click', () => {
      this.fold(!this.folded);
      this.placed();
    });
    const close = element(doc, 'button', 'icon-btn', ['✕']);
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.close());
    const head = element(doc, 'div', 'head', [element(doc, 'div', 'title', [options.title]), options.staticLayout ? null : this.foldButton, close]);
    this.panel = element(doc, 'div', 'panel', [head, this.log, element(doc, 'div', 'compose', [this.input])]);
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', options.title);
    if (options.staticLayout) this.panel.setAttribute('data-static', '');
    this.launcher = element(doc, 'button', 'launcher', [options.title]);
    this.launcher.addEventListener('click', () => this.open());
    if (options.brandColor && /^#[0-9a-f]{6}$/i.test(options.brandColor)) {
      for (const branded of [this.panel, this.launcher]) {
        branded.style.setProperty('--brand', options.brandColor);
        branded.setAttribute('data-brand', '');
      }
    }
    if (!options.staticLayout) this.makeMovable(head, options.placement ?? null);
    root.append(style, this.panel, this.launcher);
    if (options.startOpen || options.staticLayout) this.open();
    else this.close();
  }

  /** Whether the panel is open, rather than behind the launcher. */
  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  /** What has been shown so far, for restore() on another page. */
  shown(): ShownEntry[] {
    return structuredClone(this.history);
  }

  /** Draws a conversation shown on an earlier page, as it was. Only for an empty overlay. */
  restore(entries: readonly ShownEntry[]): void {
    for (const entry of entries) {
      if (entry.type === 'user') this.userMessage(entry.text);
      else if (entry.type === 'press') this.pressed(entry.press);
      else if (entry.type === 'early') this.early(entry.components);
      else if (entry.type === 'answer') this.answer(entry.text, entry.components, { budgetReached: entry.budgetReached });
      else if (entry.type === 'error') this.error(entry.message);
    }
  }

  /** Where the panel is now, as the host keeps it. */
  placement(): PanelPlacement {
    return { box: this.box && { ...this.box }, folded: this.folded };
  }

  /** Shows the panel at the latest message. A hidden panel has no layout, so scrolling while hidden (restore()) does nothing. */
  open(): void {
    this.panel.hidden = false;
    this.launcher.hidden = true;
    this.scrollToEnd();
    this.input.focus();
  }

  close(): void {
    this.panel.hidden = true;
    this.launcher.hidden = this.options.staticLayout === true;
  }

  /** Shows what the user sent and opens a reply under it. */
  userMessage(message: string): void {
    this.history.push({ type: 'user', text: message });
    this.log.querySelector('.empty')?.remove();
    this.endReply();
    this.append(element(this.doc, 'div', 'user', [message]));
    const box = element(this.doc, 'div', 'agent');
    this.reply = { box, progress: null };
    this.append(box);
  }

  // ------------------------------------------------------------ Surface: called by Brain link during a turn

  progress(text: string): void {
    // One progress line per reply, its text replaced by each new line.
    const reply = this.openReply();
    if (!reply.progress) reply.box.append((reply.progress = element(this.doc, 'div', 'progress', [element(this.doc, 'span', 'dot'), element(this.doc, 'span')])));
    reply.progress.lastElementChild!.textContent = text;
    this.scrollToEnd();
  }

  early(components: UiComponent[]): void {
    this.history.push({ type: 'early', components });
    const reply = this.openReply();
    for (const component of components) reply.box.insertBefore(renderComponent(this.doc, component, this.actions), reply.progress);
    this.scrollToEnd();
  }

  answer(text: string, components: UiComponent[], meta: { budgetReached: boolean }): void {
    this.history.push({ type: 'answer', text, components, budgetReached: meta.budgetReached });
    const reply = this.openReply();
    reply.progress?.remove();
    if (text.trim()) reply.box.append(renderText(this.doc, text));
    for (const component of components) reply.box.append(renderComponent(this.doc, component, this.actions));
    if (meta.budgetReached) reply.box.append(element(this.doc, 'div', 'budget', ['I stopped early to stay within the number of lookups allowed for one question.']));
    this.endReply();
  }

  error(message: string): void {
    this.history.push({ type: 'error', message });
    const reply = this.openReply();
    reply.progress?.remove();
    reply.box.append(element(this.doc, 'div', 'error', [message]));
    this.endReply();
  }

  // ------------------------------------------------------------ inside

  /**
   * Lets the user move, resize, fold and reset the panel.
   *   1. The saved placement, fitted to this window.
   *   2. Resize grips on the left edge, the top edge and the bottom-left corner.
   *   3. Dragging the header moves the panel. A press on it that doesn't move (a click) unfolds a folded panel;
   *      a double-click puts it back in its default place, unfolded.
   *   4. When the window shrinks, the panel is pulled back inside it.
   * A drag follows the pointer on the whole window, not only over the panel, since a fast pointer gets ahead of it.
   */
  private makeMovable(head: HTMLElement, saved: PanelPlacement | null): void {
    const win = this.doc.defaultView;
    if (!win) return;
    const viewport = (): Viewport => ({ width: win.innerWidth, height: win.innerHeight });
    // 1. The saved placement.
    if (saved) {
      this.box = saved.box && fitBox(saved.box, viewport());
      this.fold(saved.folded);
      this.applyBox();
    }
    // The panel's box when a drag starts: the dragged one, or where the default place puts it, at its unfolded height.
    const currentBox = (): PanelBox => {
      if (this.box) return { ...this.box };
      const rect = this.panel.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: this.folded ? win.innerHeight - 24 : rect.height };
    };
    /** Follows the pointer from `start` until it's released, setting the box from how far it went. */
    const follow = (start: PointerEvent, boxAt: (deltaX: number, deltaY: number) => PanelBox, released: (moved: boolean) => void) => {
      let moved = false;
      const onMove = (event: PointerEvent) => {
        const deltaX = event.clientX - start.clientX;
        const deltaY = event.clientY - start.clientY;
        // A few pixels of wobble in a click isn't a drag.
        if (!moved && Math.abs(deltaX) + Math.abs(deltaY) < 4) return;
        moved = true;
        this.box = boxAt(deltaX, deltaY);
        this.applyBox();
      };
      const onUp = () => {
        win.removeEventListener('pointermove', onMove);
        win.removeEventListener('pointerup', onUp);
        win.removeEventListener('pointercancel', onUp);
        this.panel.removeAttribute('data-dragging');
        released(moved);
      };
      win.addEventListener('pointermove', onMove);
      win.addEventListener('pointerup', onUp);
      win.addEventListener('pointercancel', onUp);
      this.panel.setAttribute('data-dragging', '');
    };
    // 2. The grips.
    for (const edge of ['left', 'top', 'bottom-left'] as const satisfies readonly ResizeEdge[]) {
      const grip = element(this.doc, 'div', `grip grip-${edge}`);
      grip.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const start = currentBox();
        follow(event, (deltaX, deltaY) => resizedBox(start, edge, deltaX, deltaY, viewport()), (moved) => moved && this.placed());
      });
      this.panel.append(grip);
    }
    // 3. The header. Its buttons keep their own clicks.
    head.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target as Element).closest('button')) return;
      // Without this, the drag would select the page's text.
      event.preventDefault();
      const start = currentBox();
      follow(event, (deltaX, deltaY) => movedBox(start, deltaX, deltaY, viewport()), (moved) => {
        if (!moved && !this.folded) return;
        if (!moved) this.fold(false);
        this.placed();
      });
    });
    head.addEventListener('dblclick', (event) => {
      if ((event.target as Element).closest('button')) return;
      this.box = null;
      this.fold(false);
      this.applyBox();
      this.placed();
    });
    // 4. A smaller window.
    win.addEventListener('resize', () => {
      if (!this.box) return;
      this.box = fitBox(this.box, viewport());
      this.applyBox();
    });
  }

  /** Puts the panel in its box, or back in the stylesheet's default place. */
  private applyBox(): void {
    const style = this.panel.style;
    if (!this.box) {
      for (const side of ['left', 'top', 'right', 'bottom', 'width', 'height']) style.removeProperty(side);
      return;
    }
    style.left = `${this.box.left}px`;
    style.top = `${this.box.top}px`;
    style.width = `${this.box.width}px`;
    style.height = `${this.box.height}px`;
    style.right = 'auto';
    style.bottom = 'auto';
  }

  /** Folds the panel down to its header, or opens it out again. */
  private fold(folded: boolean): void {
    this.folded = folded;
    this.panel.toggleAttribute('data-folded', folded);
    this.foldButton.textContent = folded ? '▢' : '–';
    this.foldButton.setAttribute('aria-label', folded ? 'Expand' : 'Minimize');
    if (!folded) this.scrollToEnd();
  }

  /** Tells the host where the panel is now. */
  private placed(): void {
    this.options.onPlacement?.(this.placement());
  }

  /** Notes a pressed button in the conversation, as a quiet line, so the user sees what the agent will be told. */
  private pressed(press: PanelPress): void {
    this.history.push({ type: 'press', press });
    this.endReply();
    this.append(element(this.doc, 'div', 'pressed', [pressText(press, this.options.siteName)]));
  }

  private send(message: string): void {
    this.userMessage(message);
    this.options.onSend(message);
  }

  /** The reply being written; a follow-up answer (with no new message) gets a fresh one. */
  private openReply(): NonNullable<Overlay['reply']> {
    if (!this.reply) {
      const box = element(this.doc, 'div', 'agent');
      this.append(box);
      this.reply = { box, progress: null };
    }
    return this.reply;
  }

  private endReply(): void {
    if (this.reply && !this.reply.box.childNodes.length) this.reply.box.remove();
    this.reply = null;
    this.scrollToEnd();
  }

  private append(node: HTMLElement): void {
    this.log.append(node);
    this.scrollToEnd();
  }

  private scrollToEnd(): void {
    if (!this.options.staticLayout) this.log.scrollTop = this.log.scrollHeight;
  }
}
