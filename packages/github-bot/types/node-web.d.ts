/**
 * Web-standard names the bot uses as types and Node implements at runtime,
 * but that @types/node does not declare globally. Only the Node entry's
 * program (tsconfig.node.json) loads this file; the Worker program takes
 * these names from workers-types.
 */

type CryptoKey = import("node:crypto").webcrypto.CryptoKey;
