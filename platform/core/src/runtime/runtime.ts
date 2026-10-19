// Starting core.js for one site on one platform: accept the remote config (the off switches) only if it is valid,
// for this site, and signed; then open a session with the resulting policy.
import type { RemoteConfig, SitePack } from '../../../contract/generated/types.ts';
import type { Host } from './host.ts';
import { effectivePolicy } from '../boundary/limits.ts';
import { Session } from './session.ts';
import type { SiteCode } from '../execute/site-code.ts';
import { describeProblems, validatorFor, type Validators } from '../shared/validate.ts';

export interface CoreOptions {
  pack: SitePack;
  site: SiteCode;
  validators: Validators;
  host: Host;
  /** The remote config as fetched; it is checked before use. */
  config?: unknown;
  usedToday?: { day: number; dayKey: number };
}

/** The remote config, or null with the reason it was ignored: malformed, for another site, or not signed. */
export async function acceptConfig(options: Pick<CoreOptions, 'pack' | 'host' | 'validators' | 'config'>): Promise<{ config: RemoteConfig | null; warnings: string[] }> {
  if (options.config === undefined || options.config === null) return { config: null, warnings: [] };
  const validator = validatorFor(options.validators.platform, 'config.json');
  if (!validator(options.config)) return { config: null, warnings: [`remote config ignored: ${describeProblems(validator)}`] };
  const config = options.config as RemoteConfig;
  if (config.site !== options.pack.site.id) return { config: null, warnings: [`remote config ignored: it is for ${config.site}`] };
  if (!options.host.verifyConfig) return { config: null, warnings: ["remote config ignored: this host can't check signatures"] };
  if (!(await options.host.verifyConfig(config))) return { config: null, warnings: ['remote config ignored: the signature check failed'] };
  return { config, warnings: [] };
}

export async function startSession(options: CoreOptions): Promise<{ session: Session; warnings: string[] }> {
  const accepted = await acceptConfig(options);
  const { policy, warnings } = effectivePolicy(options.pack, accepted.config);
  const session = new Session({ pack: options.pack, site: options.site, validators: options.validators, host: options.host, policy, ...(options.usedToday ? { usedToday: options.usedToday } : {}) });
  const all = [...accepted.warnings, ...warnings];
  for (const warning of all) session.log('config', warning);
  return { session, warnings: all };
}
