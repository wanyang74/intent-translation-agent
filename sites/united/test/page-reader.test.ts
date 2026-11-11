// Tests: United's page reader tells the page type from the URL.
// How: United's home, results and other pages, with and without the locale in the path.
// Passes when: the results page is "results", the home page "home", and everything else "other"; no page data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPage } from '../page.ts';

const pageType = (url: string) => readPage({ url, text: () => null, cookie: '', scripts: () => [] }).context.pageType;

test('page types: results, home, and other pages', () => {
  assert.equal(pageType('https://www.united.com/en/us/fsr/choose-flights?f=SFO&t=EWR&d=2026-12-08&tqp=O'), 'results');
  assert.equal(pageType('https://www.united.com/en/us/'), 'home');
  assert.equal(pageType('https://www.united.com/en/us'), 'home');
  assert.equal(pageType('https://www.united.com/'), 'home');
  assert.equal(pageType('https://www.united.com/en/us/manageres/mytrips'), 'other');
  assert.equal(readPage({ url: 'https://www.united.com/en/us/', text: () => null, cookie: '', scripts: () => [] }).data, null);
});
