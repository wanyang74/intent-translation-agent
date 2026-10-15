// Compile-time checks on the platform's generated types, run by `npm run typecheck` (never executed).
// Every @ts-expect-error line must fail to compile: if the types stop enforcing a rule, typecheck fails.
// Each site pack has its own in sites/<id>/test/types-check.ts.
import type { ClientTurn, PresentItemsArgs, PresentNoticeArgs, ToolError } from '../generated/types.ts';
import { validateMessage } from '../generated/validators.js';

// @ts-expect-error presentation calls carry IDs, not content
const cards: PresentItemsArgs = { entity: 'product', ids: [{ id: 'p-1', price: 10 }] };

// @ts-expect-error notice text comes from the site pack, never from the model
const notice: PresentNoticeArgs = { notice: 'disclosure', text: 'Our own wording' };

// @ts-expect-error error codes are generic; site detail goes in reason
const error: ToolError = { code: 'route_other_zip', message: 'x', retryable: true };

// @ts-expect-error every turn names its site
const turn: ClientTurn = { type: 'turn', sessionId: 'sess_0001abcd', traceId: 'trace_0001abcd', message: 'hi', pageContext: { url: 'https://www.example.com/', pageType: 'home' } };

/** A passing validator narrows unknown data to the generated type. */
export function answerText(data: unknown): string | null {
  return validateMessage(data) && data.type === 'answer' ? data.text : null;
}

void [cards, notice, error, turn];
