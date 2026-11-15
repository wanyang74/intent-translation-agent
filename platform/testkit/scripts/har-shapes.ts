// Prints the shape of a HAR recording's calls to a site (src/har-shapes.ts): addresses, statuses, and the names and
// types of fields, never their values. For reading a recording that holds personal data before its scrub rules exist.
// Usage: node platform/testkit/scripts/har-shapes.ts <site> <recording.har> [--path <part of the path to keep>]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadContract } from '../../contract/src/load.ts';
import { formatShapes, harShapes } from '../src/har-shapes.ts';

const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { path: { type: 'string', multiple: true } } });
const [site, harPath] = positionals;
if (!site || !harPath) {
  console.error('Usage: node platform/testkit/scripts/har-shapes.ts <site> <recording.har> [--path <part of the path to keep>]');
  process.exit(2);
}
const { pack } = loadContract({ sites: [site] }).sites[site]!;
const shapes = harShapes(JSON.parse(readFileSync(harPath, 'utf8')), pack.site.origins);
const kept = options.path?.length ? shapes.filter((shape) => options.path!.some((part) => shape.path.toLowerCase().includes(part.toLowerCase()))) : shapes;
console.log(formatShapes(kept));
console.error(`${kept.length} of ${shapes.length} calls to ${site}'s origins`);
