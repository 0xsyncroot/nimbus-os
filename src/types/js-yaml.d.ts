declare module 'js-yaml' {
  export const CORE_SCHEMA: unknown;
  export const FAILSAFE_SCHEMA: unknown;
  export function load(input: string, opts?: { schema?: unknown }): unknown;
  export function dump(input: unknown, opts?: { schema?: unknown }): string;
  const def: {
    CORE_SCHEMA: unknown;
    FAILSAFE_SCHEMA: unknown;
    load: typeof load;
    dump: typeof dump;
  };
  export default def;
}
