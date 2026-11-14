// UI states no site's conversations or references produce yet: a comparison table, a form, an error, a turn still
// running, early results, a reached call budget and a Take me there button. Written by hand in the UI fixture format, with a made-up "item"
// entity, so the overlay is built and screenshot-tested for every component and state, not only the ones that
// recorded traffic happens to reach. Replace each one with a made fixture once a site produces it.
import type { UiFixture } from '../src/ui-fixture.ts';

const page = { url: 'https://shop.example/items', pageType: 'search' };

const field = (key: string, label: string, text: string, value: unknown, estimate = false) => ({ key, label, text, value, ...(estimate ? { estimate } : {}) });

export const UI_STATES: UiFixture[] = [
  {
    id: 'state-comparison', site: 'platform', source: 'conversation', description: 'A comparison table of three items, one value missing',
    turns: [{
      message: 'Compare the three cheapest', page,
      events: [
        { type: 'progress', text: 'Comparing 3 items…' },
        {
          type: 'answer', budgetReached: false, text: 'Here they are side by side. **Item B** costs the least in total.',
          components: [{
            type: 'comparison', entity: 'item',
            items: [{ id: 1, title: 'Item A', link: 'https://shop.example/items/1' }, { id: 2, title: 'Item B', link: 'https://shop.example/items/2' }, { id: 3, title: 'Item C' }],
            rows: [
              { key: 'price', label: 'Price', cells: [field('price', 'Price', '$1,200', 1200), field('price', 'Price', '$980', 980), field('price', 'Price', '$1,050', 1050)] },
              { key: 'total', label: 'Estimated total', cells: [field('total', 'Estimated total', '$1,310', 1310, true), field('total', 'Estimated total', '$1,070', 1070, true), field('total', 'Estimated total', 'not available', null, true)] },
              { key: 'delivery', label: 'Delivery', cells: [field('delivery', 'Delivery', 'Friday', 'Friday'), field('delivery', 'Delivery', 'Monday', 'Monday'), field('delivery', 'Delivery', 'Saturday', 'Saturday')] },
            ],
          }, { type: 'notice', notice: 'estimated_total', text: 'Estimated totals include estimated taxes and fees. Final amounts are set at checkout.' }],
        },
      ],
    }],
  },
  {
    id: 'state-form', site: 'platform', source: 'conversation', description: 'A form with a prefilled field, a choice and an optional date',
    turns: [{
      message: 'I want to book something', page,
      events: [{
        type: 'answer', budgetReached: false, text: 'A few details first:',
        components: [{
          type: 'form', form: 'booking', heading: 'Booking details',
          fields: [
            { key: 'postal', label: 'Postal code', type: 'text', required: true, value: '94402' },
            { key: 'size', label: 'Size', type: 'text', required: true, options: ['Small', 'Medium', 'Large'] },
            { key: 'date', label: 'Date', type: 'date', required: false },
          ],
        }],
      }],
    }],
  },
  {
    id: 'state-error', site: 'platform', source: 'conversation', description: 'A turn that ends in an error after a progress line',
    turns: [{ message: 'Find me one', page, events: [{ type: 'progress', text: 'Searching…' }, { type: 'error', message: 'Lost the connection to the assistant. Try again.' }] }],
  },
  {
    id: 'state-running', site: 'platform', source: 'conversation', description: 'A turn still running: early results, then a progress line',
    turns: [{
      message: 'Show me what you have', page,
      events: [
        { type: 'early', components: [{ type: 'items', entity: 'item', layout: 'list', items: [{ id: 1, title: 'Item A', subtitle: 'Blue · small', fields: [field('price', 'Price', '$1,200', 1200)], link: 'https://shop.example/items/1' }, { id: 2, title: 'Item B', subtitle: 'Red · large', fields: [field('price', 'Price', '$980', 980)] }] }] },
        { type: 'progress', text: 'Checking delivery dates for 2 items…' },
      ],
    }],
  },
  {
    id: 'state-options', site: 'platform', source: 'conversation', description: 'Options to pick from, after a list of cards',
    turns: [{
      message: 'Help me narrow it down', page,
      events: [{
        type: 'answer', budgetReached: false, text: 'Pick one to narrow the list:',
        components: [{ type: 'options', entity: 'filter', heading: 'Narrow it down', options: [{ id: 'f1', title: 'Under $1,000', subtitle: '12 items', fields: [] }, { id: 'f2', title: 'Ships this week', subtitle: '30 items', fields: [] }] }],
      }],
    }],
  },
  {
    id: 'state-hostile-text', site: 'platform', source: 'conversation', description: 'Markup and a script link in text from the site: shown as text, never run',
    turns: [{
      message: 'What do reviewers say? <b>bold?</b>', page,
      events: [{
        type: 'answer', budgetReached: false, text: 'One review says: <img src=x onerror="window.hacked=1"> great item.',
        components: [{
          type: 'detail', entity: 'item',
          card: { id: 1, title: 'Item <script>window.hacked=1</script>', fields: [field('price', 'Price', '$1,200', 1200)], link: 'javascript:window.hacked=1' },
          sections: [{ name: 'reviews', summary: '<i>4.5</i> stars', lines: [{ text: '<a href="https://evil.example">click</a>', meta: '2026-01-01' }] }],
        }],
      }],
    }],
  },
  {
    id: 'state-budget', site: 'platform', source: 'conversation', description: 'An answer cut short by the call budget, with a bullet list',
    turns: [{
      message: 'Check every page', page,
      events: [{ type: 'answer', budgetReached: true, text: 'I checked 5 of the 40 pages:\n- 120 items matched\n- the cheapest is **$980**\n\nAsk me to narrow it down and I can look further.', components: [] }],
    }],
  },
  {
    id: 'state-destination', site: 'platform', source: 'conversation', description: 'A short answer with a Take me there button to a page on the site',
    turns: [{
      message: 'Take me to the returns policy', page,
      events: [{
        type: 'answer', budgetReached: false, text: 'Returns are free within 30 days of delivery. The policy page has the details.',
        components: [{ type: 'destination', destination: 'returns_policy', title: 'Returns policy', url: 'https://shop.example/help/returns' }],
      }],
    }],
  },
  {
    id: 'state-page-action', site: 'platform', source: 'conversation',
    description: 'An item with no page of its own: its card and the Take me there button open the page that lists it, with its details to open there',
    turns: [{
      message: 'Book the 8:45 one', page,
      events: [{
        type: 'answer', budgetReached: false, text: "I can't book, but this opens the list with that departure's details open.",
        components: [
          { type: 'items', entity: 'departure', layout: 'cards', items: [{ id: 'dep_1', title: 'Departure 1', subtitle: '8:45 AM to 5:23 PM', fields: [], go: { url: 'https://shop.example/list?d=1', focus: { action: 'open_details', target: { id: 'dep_1' }, hint: 'the 8:45 AM departure' } } }] },
          { type: 'destination', destination: 'departure_list', title: 'This departure', url: 'https://shop.example/list?d=1', focus: { action: 'open_details', target: { id: 'dep_1' }, hint: 'the 8:45 AM departure' }, item: { kind: 'departure', id: 'dep_1' } },
        ],
      }],
    }],
  },
  {
    id: 'state-write-action', site: 'platform', source: 'conversation',
    description: 'A button whose page action changes the site (D6): what will change, what the user agrees to, and a label that says what it does; one press',
    turns: [{
      message: 'Add the 8:45 one, standard fare, to my cart', page,
      events: [{
        type: 'answer', budgetReached: false, text: 'Press the button to add it to your cart on the site. I will tell you once the site shows it.',
        components: [{
          type: 'destination', destination: 'add_to_cart', title: 'Add to your cart', url: 'https://shop.example/list?d=1', item: { kind: 'fare', id: 'fare_1' },
          focus: { action: 'add_fare_to_cart', target: { id: 'dep_1', fare: 'standard' }, hint: 'the 8:45 AM departure, Standard, $377' },
          confirm: { summary: ['Departure 1, 8:45 AM to 5:23 PM', 'Standard fare', '$377'], consent: "Puts it in your cart on the shop's site. Nothing is bought: you choose seats and pay there.", button: 'Add to cart on the shop' },
        }],
      }],
    }],
  },
];
