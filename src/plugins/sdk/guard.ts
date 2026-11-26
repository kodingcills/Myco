/**
 * Sandbox preload for plugin children (capability track T). Loaded with `--import` BEFORE
 * any plugin code, in a child started with Node's permission model (`--permission`, reads
 * allowed only for the SDK and the plugin directory; no writes, child processes, workers,
 * addons or WASI).
 *
 * Node 22/24's permission model has no network switch, so this preload closes the network
 * (and every other ambient capability) at the module layer:
 *  - only an allowlist of pure builtins resolves; `net`, `http`, `dns`, `fs`, `module`, `vm`,
 *    `os`, `child_process`, ... throw `PLUGIN_CAP_DENIED` (so a plugin cannot register its own
 *    resolve hook ahead of this one either: `node:module` is denied);
 *  - only `file:` modules resolve (no `data:`, `http:`, bare npm packages);
 *  - `fetch`, `WebSocket`, `EventSource` are removed; `process.getBuiltinModule` and
 *    `process.kill` are replaced, non-writable and non-configurable.
 * `process.binding` is already denied by the permission model.
 * `test/plugins/sandbox.test.ts` proves each of these from inside a hostile plugin.
 */
import { isBuiltin, registerHooks } from "node:module";

const ALLOWED_BUILTINS = new Set([
  "assert",
  "assert/strict",
  "buffer",
  "crypto",
  "events",
  "path",
  "path/posix",
  "querystring",
  "stream",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "url",
  "util",
  "util/types",
  "zlib",
]);

function denied(what: string): Error {
  const e = new Error(`PLUGIN_CAP_DENIED: ${what}`) as Error & { code: string };
  e.code = "PLUGIN_CAP_DENIED";
  return e;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBuiltin(specifier)) {
      const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
      if (!ALLOWED_BUILTINS.has(bare)) throw denied(specifier);
      return nextResolve(specifier, context);
    }
    const resolved = nextResolve(specifier, context);
    if (!resolved.url.startsWith("file:")) throw denied(specifier);
    return resolved;
  },
});

for (const name of ["fetch", "WebSocket", "EventSource"]) {
  Reflect.deleteProperty(globalThis, name);
}
for (const name of ["getBuiltinModule", "kill"]) {
  Object.defineProperty(process, name, {
    value: () => {
      throw denied(`process.${name}`);
    },
    writable: false,
    configurable: false,
  });
}
