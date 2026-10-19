// The generated validators, looked up by schema path. core.js takes them as modules (the platform's and the site's
// generated validators.js), so checks run the same way everywhere, with no schema compiler at run time.
import { validatorName } from '../../../contract/src/names.ts';

export interface Validator {
  (data: unknown): boolean;
  errors?: { instancePath: string; message?: string }[] | null;
}

export interface Validators {
  /** platform/contract/generated/validators.js */
  platform: Record<string, unknown>;
  /** sites/<id>/generated/validators.js */
  site: Record<string, unknown>;
}

export function validatorFor(module: Record<string, unknown>, schemaPath: string): Validator {
  const exported = module[validatorName(schemaPath)];
  if (typeof exported !== 'function') throw new Error(`no generated validator for ${schemaPath}`);
  return exported as Validator;
}

/** A short description of why data failed a validator: the first two problems. */
export function describeProblems(validator: Validator): string {
  return (validator.errors ?? []).slice(0, 2).map((problem) => `${problem.instancePath || 'the value'} ${problem.message ?? 'is invalid'}`).join('; ') || 'it is invalid';
}

/** Runs a validator: null when the data is valid, otherwise a short description of the problem. */
export function problemsWith(module: Record<string, unknown>, schemaPath: string, data: unknown): string | null {
  const validator = validatorFor(module, schemaPath);
  return validator(data) ? null : describeProblems(validator);
}
