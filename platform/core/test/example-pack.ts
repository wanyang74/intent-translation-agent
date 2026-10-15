// A made-up shop, used only by core.js's own tests. It's small enough to read, and it has what the checks look at:
// integer and text IDs, IDs that expire at a time or a while after they're shown, an internal kind, a kind that needs
// sign-in, a write tool, a form, a notice, an allowed-value rule and both kinds of deep-link placeholder.
import type { SitePack } from '../../contract/generated/types.ts';

export const examplePack: SitePack = {
  site: {
    id: 'example-shop', name: 'Example Shop', origins: ['https://www.example.com', 'https://api.example.com'],
    locale: 'en-US', pageTypes: ['home', 'product', 'account'], requires: { location: 'none', signIn: 'some_tools' },
  },
  entities: {
    product: {
      description: 'Something for sale',
      id: { type: 'integer' },
      fields: {
        price: { label: 'Price', type: 'money', from: 'price' },
        total: { label: 'Total', type: 'money', estimate: true, from: 'derived' },
        rating: { label: 'Rating', type: 'number', from: 'rating' },
        name: { label: 'Name', type: 'text', from: 'name' },
      },
      card: { title: '{name}', subtitle: '{rating} stars', fields: ['price', 'total'], link: 'product' },
      sections: ['overview', 'reviews'],
    },
    offer: {
      description: 'A price held for a while',
      id: { type: 'string', pattern: '^of_[a-z0-9]{4}$' },
      expires: { field: 'expiresAt' },
      fields: { amount: { label: 'Amount', type: 'money', from: 'amount' } },
      card: { title: '{amount}', fields: ['amount'] },
    },
    coupon: { description: 'A code that lasts ten minutes once shown', id: { type: 'string', pattern: '^[A-Z]{5}$' }, expires: { afterSeconds: 600 } },
    order: { description: "The shopper's order", id: { type: 'string', pattern: '^[A-Z0-9]{6}$' }, requiresSignIn: true, card: { title: '{id}' } },
    token: { description: 'A routing token', id: { type: 'string' }, internal: true },
  },
  endpoints: {
    search: {
      method: 'POST', url: 'https://api.example.com/search', request: 'endpoints/search.request.json', response: 'endpoints/search.response.json',
      headers: { 'x-shop-client': 'web' }, tracking: { fields: ['visitorId', 'analytics.clientRef'], headers: ['visitorid'] },
      matchKey: ['query', 'colors'], ids: [{ kind: 'product', path: 'items[].id' }],
    },
    filters: { method: 'GET', url: 'https://api.example.com/filters', request: 'endpoints/filters.request.json', response: 'endpoints/filters.response.json', matchKey: ['query'] },
    orders: { method: 'GET', url: 'https://api.example.com/orders', request: 'endpoints/orders.request.json', response: 'endpoints/orders.response.json', matchKey: ['status'], signIn: true },
    checkout: { method: 'POST', url: 'https://api.example.com/checkout', request: 'endpoints/checkout.request.json', response: 'endpoints/checkout.response.json', matchKey: ['offerId'] },
    page: { method: 'GET', url: 'https://www.example.com/p/{productId}', responseFormat: 'html', request: 'endpoints/page.request.json', response: 'endpoints/page.response.json', matchKey: ['productId'] },
  },
  tools: {
    search_products: {
      description: 'Search products', input: 'tools/search_products.input.json', output: 'tools/search_products.output.json',
      uses: ['search', 'filters'], sideEffect: 'read', presentation: 'present_items',
      nextStep: 'To see an offer, call get_offer with its ID.',
      ids: { output: [
        { kind: 'product', path: 'products[].id' },
        { kind: 'offer', path: 'offers[].id', expiresAt: 'offers[].expiresAt' },
        { kind: 'coupon', path: 'coupons[]' },
        { kind: 'token', path: 'token' },
      ] },
      errors: { bad_color: { code: 'invalid_value', message: "'{value}' isn't one of the {field} we sell. Try one of: {options}.", retryable: true } },
    },
    get_offer: {
      description: 'One offer', input: 'tools/get_offer.input.json', output: 'tools/get_offer.output.json',
      uses: ['search'], sideEffect: 'read', presentation: 'present_detail',
      ids: { input: [{ kind: 'offer', path: 'offerId' }] },
      errors: { offer_gone: { code: 'expired', message: 'That offer ended. Search again for a current price.', retryable: true } },
    },
    compare_products: {
      description: 'Products side by side', input: 'tools/compare_products.input.json', output: 'tools/compare_products.output.json',
      uses: ['search'], sideEffect: 'read', presentation: 'present_comparison',
      ids: { input: [{ kind: 'product', path: 'productIds[]' }] },
    },
    my_orders: {
      description: "The shopper's orders", input: 'tools/my_orders.input.json', output: 'tools/my_orders.output.json',
      uses: ['orders'], sideEffect: 'read', signIn: true,
      ids: { output: [{ kind: 'order', path: 'orders[].id' }] },
      errors: { signed_out: { code: 'auth_required', message: 'Ask the shopper to sign in first.', retryable: true } },
    },
    read_product_page: {
      description: "A product's details from its page", input: 'tools/read_product_page.input.json', output: 'tools/read_product_page.output.json',
      uses: ['page'], sideEffect: 'read', presentation: 'present_detail', ids: { input: [{ kind: 'product', path: 'productId' }] },
    },
    place_order: {
      description: 'Buy an offer', input: 'tools/place_order.input.json', output: 'tools/place_order.output.json',
      uses: ['checkout'], sideEffect: 'write', ids: { input: [{ kind: 'offer', path: 'offerId' }] },
    },
  },
  forms: {
    shipping: {
      description: 'Where and how to ship',
      fields: {
        zip: { label: 'Zip', type: 'code', required: true, pattern: '^[0-9]{5}$' },
        speed: { label: 'Speed', type: 'select', options: ['standard', 'express'] },
        quantity: { label: 'Quantity', type: 'integer', min: 1, max: 9 },
      },
      submitTool: 'place_order',
    },
  },
  notices: { total_estimate: { text: 'Totals are estimates until checkout.', source: 'example wording', version: '1', showWith: ['total'] } },
  policies: {
    hiddenFields: ['installments'],
    derivedFields: { total: { formula: 'price + shipping.cost', label: 'Total', estimate: true, appliesTo: 'product' } },
    allowedValues: { 'search_products.colors': 'filters.colors[].key' },
    pageSize: 20,
    rateLimitPerSecond: 2,
    callBudget: { perTask: 5, perSession: 8, perDay: 10 },
    priceDisplay: 'as_returned',
    writes: 'none',
  },
  deepLinks: {
    product: { template: 'https://www.example.com/p/{id}' },
    search: { template: 'https://www.example.com/s?q={query}&state={base64json:state}' },
  },
  recording: { scrubFields: [], scrubHeaders: [], keepHeaders: [] },
};
