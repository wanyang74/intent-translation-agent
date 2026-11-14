// What a site pack's code provides: one implementation per tool the site pack declares, plus a few optional helpers.
// Site code reaches the site only through the ToolContext the platform hands it, so every request still goes through
// the boundary checks, the shared budget, the rate limit, the cache and the response checks (decision D5).
import type { PageContext, ToolError } from '../../../contract/generated/types.ts';
import type { IdView } from '../boundary/ids.ts';

export interface EndpointRequest {
  /** POST: the JSON body. Tracking fields the site pack lists are added if missing. */
  body?: Record<string, unknown>;
  /** GET: query parameters, in this order. */
  query?: Record<string, string | number | boolean>;
  /** Values for {name} segments in the endpoint's URL. */
  params?: Record<string, string | number>;
  /** Extra headers, such as a constant client ID. Tracking headers the site pack lists are added if missing. */
  headers?: Record<string, string>;
}

export interface ToolContext {
  readonly tool: string;
  /** The tool's arguments, already checked against its input schema and the boundary rules. */
  readonly args: any;
  readonly page: PageContext | undefined;
  /** IDs this session has seen; read-only. */
  readonly ids: IdView;
  readonly now: number;
  /** Calls an endpoint this tool declares in `uses`, and returns the checked response. */
  call(endpoint: string, request: EndpointRequest): Promise<any>;
  /** The site pack's derived fields for one item of an entity kind. */
  derived(kind: string, item: unknown): Record<string, number>;
  /** A deep link from the site pack's templates, or undefined if a value is missing. */
  link(name: string, params: Record<string, unknown>): string | undefined;
  /** Text the site's users wrote, cleaned and fenced for the model. */
  fence(text: unknown, source: string, maxLength?: number): string;
  /** Stops the tool with one of the errors it declares in the site pack. */
  fail(reason: string, values?: Record<string, unknown>): never;
  /** Scratch space for this site's code, kept for the session, such as raw records by ID for later tools. */
  readonly store: Map<string, unknown>;
  /** What the page the user is on carries about the item on screen, if the host can read it. */
  pageData(): unknown;
  /** A progress line for the user while the tool runs. */
  progress(text: string): void;
  /** Keeps what the tool knows about an item for display, such as a car's year, make and model read from its page. */
  keep(kind: string, id: string | number, record: Record<string, unknown>): void;
}

export type ToolImpl = (ctx: ToolContext) => Promise<Record<string, unknown>>;

/** A section of a detail view beyond the platform's overview: some text, a few lines, or both. */
export interface SectionContent {
  summary?: string;
  lines?: { text: string; meta?: string }[];
}

/** One item as Respond sees it: every tool's record for it merged (later tools win), and each tool's own. */
export interface EntityView {
  kind: string;
  id: string | number;
  values: Record<string, unknown>;
  byTool: Record<string, unknown>;
}

export interface SiteCode {
  tools: Record<string, ToolImpl>;
  /** For allowed-value rules: how to fetch an endpoint's response when the session has none yet. */
  valueSources?: Record<string, (args: any) => EndpointRequest>;
  /** Readers for endpoints whose response is a page (responseFormat: html): page text in, data out. */
  parsers?: Record<string, (html: string) => unknown>;
  /**
   * URL builders for destinations whose URL a deep-link template can't express, by destination name: the checked
   * params in, a URL out (or undefined), built with the site pack's deep links. Only URLs on the site's origins are used.
   * A destination with a page action returns its target too: what the page code looks for on the page it opens.
   */
  destinations?: Record<string, DestinationBuilder>;
  /** Builders for detail-view sections beyond the overview, by section name. */
  sections?: Record<string, (view: EntityView) => SectionContent | null>;
}

/**
 * Builds one destination's URL. `store` is what the tools kept this session (read-only here), so a destination for an
 * item can find the search it came from.
 */
export type DestinationBuilder = (
  params: any,
  link: (name: string, values: Record<string, unknown>) => string | undefined,
  store: ReadonlyMap<string, unknown>,
) => string | BuiltDestination | undefined;

export interface BuiltDestination {
  url: string;
  /** For the destination's page action: what to find on the page, and how to tell the user to find it themselves. */
  focus?: { target: unknown; hint: string };
  /**
   * For a page action that changes the site: the item in a few lines (what, which, price), from what the tools
   * returned, shown with the confirming button so the user sees exactly what will change.
   */
  summary?: string[];
}

/** Thrown inside a tool to stop it with an error the model can act on. */
export class ToolFailure extends Error {
  error: ToolError;
  constructor(error: ToolError) {
    super(error.message);
    this.error = error;
  }
}
