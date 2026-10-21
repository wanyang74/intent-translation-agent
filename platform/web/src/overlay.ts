// The overlay: the web surface, a chat panel on the right of the site's page. It implements core.js's Surface, so
// Brain link drives it the same way it drives FakeSurface in tests and the native sheets later. It draws what it's
// told and reports what the user typed; deciding whether a message starts a turn or amends one is the controller's
// job (agent.ts). Everything lives in a shadow root, apart from the site's DOM and CSS. It keeps a record of what it
// has shown (shown()), so the next page of the site can draw the same conversation again (restore()).
import type { Surface } from '../../core/src/link/link.ts';
import type { UiComponent } from '../../core/src/present/present.ts';
import type { ShownEntry } from './conversation.ts';
import { element, renderComponent, renderText, type ComponentActions } from './render.ts';
import { OVERLAY_CSS } from './styles.ts';

export interface OverlayOptions {
  /** The panel's title, such as "Ask <site name>". */
  title: string;
  /** Shown in an empty conversation. */
  greeting?: string;
  /** The user sent a message: typed, an option picked, or a form submitted. */
  onSend(message: string): void;
  /** The user tapped Take me there. Without it, the page opens in the same tab. */
  onNavigate?(url: string): void;
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

  /** Draws the overlay inside a shadow root on `mountPoint`. */
  constructor(doc: Document, mountPoint: HTMLElement, options: OverlayOptions) {
    this.doc = doc;
    this.options = options;
    this.actions = {
      send: (message) => this.send(message),
      navigate: (url) => (options.onNavigate ? options.onNavigate(url) : doc.defaultView?.location.assign(url)),
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
    const close = element(doc, 'button', 'icon-btn', ['✕']);
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.close());
    this.panel = element(doc, 'div', 'panel', [
      element(doc, 'div', 'head', [element(doc, 'div', 'title', [options.title]), close]),
      this.log,
      element(doc, 'div', 'compose', [this.input]),
    ]);
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', options.title);
    if (options.staticLayout) this.panel.setAttribute('data-static', '');
    this.launcher = element(doc, 'button', 'launcher', [options.title]);
    this.launcher.addEventListener('click', () => this.open());
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
      else if (entry.type === 'early') this.early(entry.components);
      else if (entry.type === 'answer') this.answer(entry.text, entry.components, { budgetReached: entry.budgetReached });
      else if (entry.type === 'error') this.error(entry.message);
    }
  }

  open(): void {
    this.panel.hidden = false;
    this.launcher.hidden = true;
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
