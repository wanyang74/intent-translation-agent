// Rebuilds every site's UI fixtures (sites/<id>/ui-fixtures/) from its example conversations and eval references.
//   npm run ui-fixtures
import { listSites } from '../../contract/src/site-pack.ts';
import { buildUiFixtures, writeUiFixtures } from '../build/ui-fixtures.ts';

for (const site of listSites()) {
  const fixtures = await buildUiFixtures(site);
  writeUiFixtures(site, fixtures);
  console.log(`${site}: ${fixtures.length} UI fixtures`);
}
