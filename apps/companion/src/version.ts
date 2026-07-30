// Single source of truth is package.json; bundlers inline it at build time.
import pkg from "../package.json" with { type: "json" };
export const VERSION: string = (pkg as { version: string }).version;
