// Starting core.js for one site on one platform: accept the remote config (the off switches) only if it is valid,
// for this site, and signed; then open a session with the resulting policy.
import type { RemoteConfig, SitePack } from '../../contract/generated/types.ts';
import type { Host } from './host.ts';
import { effectivePolicy } from './limits.ts';
import { Session } from './session.ts';
import type { SiteCode } from './site-code.ts';
import { describeProblems, validatorFor, type Validators } from './validate.ts';

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
export async function acceptConfig(o: Pick<CoreOptions, 'pack' | 'host' | 'validators' | 'config'>): Promise<{ config: RemoteConfig | null; warnings: string[] }> {
  if (o.config === undefined || o.config === null) return { config: null, warnings: [] };
  const v = validatorFor(o.validators.platform, 'config.json');
  if (!v(o.config)) return { config: null, warnings: [`remote config ignored: ${describeProblems(v)}`] };
  const config = o.config as RemoteConfig;
  if (config.site !== o.pack.site.id) return { config: null, warnings: [`remote config ignored: it is for ${config.site}`] };
  if (!o.host.verifyConfig) return { config: null, warnings: ["remote config ignored: this host can't check signatures"] };
  if (!(await o.host.verifyConfig(config))) return { config: null, warnings: ['remote config ignored: the signature check failed'] };
  return { config, warnings: [] };
}

export async function startSession(o: CoreOptions): Promise<{ session: Session; warnings: string[] }> {
  const accepted = await acceptConfig(o);
  const { policy, warnings } = effectivePolicy(o.pack, accepted.config);
  const session = new Session({ pack: o.pack, site: o.site, validators: o.validators, host: o.host, policy, ...(o.usedToday ? { usedToday: o.usedToday } : {}) });
  const all = [...accepted.warnings, ...warnings];
  for (const w of all) session.log('config', w);
  return { session, warnings: all };
}
