/**
 * The domain vocabulary: what an issue, a period, a type and a problem are,
 * plus the pure logic over them. No filesystem, no config parsing, no I/O —
 * everything here is a value in, a value out, which is why it is the one layer
 * every other layer may depend on.
 */
export * from './attributes.js';
export * from './links.js';
export * from './profile.js';
export * from './types.js';
