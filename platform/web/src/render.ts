// Draws Respond's UI components as DOM, for the overlay. Every value comes already filled in from tool results (core.js
// did that); this file only lays them out. It never parses HTML: all text goes in through textContent, so a review or
// a car description that contains markup shows as text and can't run. Links are kept only when they're http(s).
import type { CardView, DetailSection, FieldView, FormFieldView, UiComponent } from '../../core/src/present/present.ts';
import { NOT_AVAILABLE } from '../../core/src/present/present.ts';

/** What a component can ask of the overlay when the user acts on it. */
export interface ComponentActions {
  /** Sends a message as if the user typed it: a picked option, or a submitted form. */
  send(message: string): void;
}

type Children = (Node | string | null | undefined | false)[];

/** An element with a class and children; strings become text nodes. */
export function element(doc: Document, tag: string, className?: string, children: Children = []): HTMLElement {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  }
  return node;
}

/** A link to the site, or nothing when the URL isn't http(s). It opens in a new tab so the conversation stays. */
function siteLink(doc: Document, href: string | undefined, label: string): HTMLElement | null {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  const link = element(doc, 'a', 'link', [label]) as HTMLAnchorElement;
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function fieldList(doc: Document, fields: FieldView[]): HTMLElement {
  const list = element(doc, 'dl', 'fields');
  for (const field of fields) {
    const value = element(doc, 'dd', field.text === NOT_AVAILABLE ? 'na' : undefined, [field.text, field.estimate && field.text !== NOT_AVAILABLE ? element(doc, 'span', 'est', ['est.']) : null]);
    list.append(element(doc, 'dt', undefined, [field.label]), value);
  }
  return list;
}

function card(doc: Document, view: CardView): HTMLElement {
  return element(doc, 'div', 'card', [
    element(doc, 'div', 'main', [element(doc, 'div', 't', [view.title]), view.subtitle ? element(doc, 'div', 'st', [view.subtitle]) : null]),
    view.fields.length ? fieldList(doc, view.fields) : null,
    siteLink(doc, view.link, 'View on site ↗'),
  ]);
}

function section(doc: Document, content: DetailSection): HTMLElement {
  return element(doc, 'div', 'section', [
    element(doc, 'div', 'name', [content.name]),
    content.summary ? element(doc, 'p', 'summary', [content.summary]) : null,
    content.lines?.length ? element(doc, 'ul', undefined, content.lines.map((line) => element(doc, 'li', undefined, [line.text, line.meta ? element(doc, 'span', 'meta', [` · ${line.meta}`]) : null]))) : null,
    content.fields?.length ? fieldList(doc, content.fields) : null,
  ]);
}

/** One input of a form, typed by the site pack's field type. */
function formInput(doc: Document, field: FormFieldView): HTMLElement {
  if (field.options?.length) {
    const select = doc.createElement('select');
    select.name = field.key;
    select.required = field.required;
    for (const option of ['', ...field.options]) {
      const choice = element(doc, 'option', undefined, [option]) as HTMLOptionElement;
      choice.value = option;
      choice.selected = field.value === option;
      select.append(choice);
    }
    return select;
  }
  const input = doc.createElement('input');
  input.name = field.key;
  input.required = field.required;
  input.type = field.type === 'date' ? 'date' : field.type === 'integer' || field.type === 'number' ? 'number' : 'text';
  if (field.min !== undefined) input.min = String(field.min);
  if (field.max !== undefined) input.max = String(field.max);
  if (field.value !== undefined && field.value !== null) input.value = String(field.value);
  return input;
}

/**
 * A form the model asked the user to fill in. Submitting sends the values as the user's next message, one line per
 * field, so the model reads them like anything else the user says; the mini version never submits to the site.
 */
function form(doc: Document, component: Extract<UiComponent, { type: 'form' }>, actions: ComponentActions): HTMLElement {
  const box = element(doc, 'form', 'form', [component.heading ? element(doc, 'div', 'heading', [component.heading]) : null]) as HTMLFormElement;
  const inputs = component.fields.map((field) => {
    const input = formInput(doc, field);
    box.append(element(doc, 'label', undefined, [`${field.label}${field.required ? '' : ' (optional)'}`, input]));
    return { field, input: input as HTMLInputElement | HTMLSelectElement };
  });
  const submit = element(doc, 'button', 'btn', ['Send']) as HTMLButtonElement;
  submit.type = 'submit';
  box.append(submit);
  box.addEventListener('submit', (event) => {
    event.preventDefault();
    const lines = inputs.filter(({ input }) => input.value.trim()).map(({ field, input }) => `${field.label}: ${input.value.trim()}`);
    if (!lines.length) return;
    submit.disabled = true;
    actions.send(lines.join('\n'));
  });
  return box;
}

/** One UI component as DOM. */
export function renderComponent(doc: Document, component: UiComponent, actions: ComponentActions): HTMLElement {
  switch (component.type) {
    case 'items':
      return element(doc, 'div', 'items', [
        component.heading ? element(doc, 'div', 'heading', [component.heading]) : null,
        element(doc, 'div', `cards ${component.layout}`, component.items.map((item) => card(doc, item))),
      ]);
    case 'options':
      return element(doc, 'div', 'options', [
        component.heading ? element(doc, 'div', 'heading', [component.heading]) : null,
        element(doc, 'div', 'chips', component.options.map((option) => {
          const chip = element(doc, 'button', 'chip', [option.title, option.subtitle ? element(doc, 'span', 'st', [option.subtitle]) : null]) as HTMLButtonElement;
          chip.type = 'button';
          chip.addEventListener('click', () => actions.send(option.title));
          return chip;
        })),
      ]);
    case 'comparison': {
      const headRow = element(doc, 'tr', undefined, [element(doc, 'th'), ...component.items.map((item) => element(doc, 'th', undefined, [siteLink(doc, item.link, item.title) ?? item.title]))]);
      const rows = component.rows.map((row) => element(doc, 'tr', undefined, [
        element(doc, 'td', undefined, [row.label]),
        ...row.cells.map((cell) => element(doc, 'td', cell.text === NOT_AVAILABLE ? 'na' : undefined, [cell.text, cell.estimate && cell.text !== NOT_AVAILABLE ? element(doc, 'span', 'est', ['est.']) : null])),
      ]));
      return element(doc, 'div', 'compare', [element(doc, 'table', undefined, [element(doc, 'thead', undefined, [headRow]), element(doc, 'tbody', undefined, rows)])]);
    }
    case 'detail': {
      const detail = card(doc, component.card);
      for (const content of component.sections) detail.append(section(doc, content));
      return detail;
    }
    case 'form':
      return form(doc, component, actions);
    case 'notice':
      return element(doc, 'div', 'notice', [component.text]);
  }
}

/**
 * The model's text as paragraphs, bullet lists and bold, the little Markdown it writes. Anything else stays as typed.
 * Built from text nodes, never innerHTML.
 */
export function renderText(doc: Document, text: string): HTMLElement {
  const box = element(doc, 'div', 'text');
  const inline = (line: string): Children => line.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? element(doc, 'strong', undefined, [part]) : part));
  const bullet = /^\s*[-*•]\s+/;
  for (const block of text.trim().split(/\n\s*\n/)) {
    // Consecutive bullet lines make one list; the lines between them make paragraphs with line breaks.
    let list: HTMLElement | null = null;
    let paragraph: HTMLElement | null = null;
    for (const line of block.split('\n')) {
      if (bullet.test(line)) {
        paragraph = null;
        if (!list) box.append((list = element(doc, 'ul')));
        list.append(element(doc, 'li', undefined, inline(line.replace(bullet, ''))));
      } else {
        list = null;
        if (paragraph) paragraph.append(doc.createElement('br'));
        else box.append((paragraph = element(doc, 'p')));
        paragraph.append(...inline(line).filter((part): part is Node | string => !!part));
      }
    }
  }
  return box;
}
