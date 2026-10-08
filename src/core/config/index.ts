/**
 * The board configuration: parsing `.lpm/config.yml` into a validated
 * `BoardConfig` (schema.ts) and answering questions about it (lookup.ts).
 * Every rule about hierarchy depth, statuses and type namespaces is resolved
 * here so callers never inspect the raw config shape.
 */
export * from './lookup.js';
export * from './remote-blocks.js';
export * from './schema.js';
