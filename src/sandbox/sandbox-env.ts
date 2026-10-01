import type { SandboxHandle } from "./sandbox.ts";
import { shq } from "../util/shell.ts";
export const NONINTERACTIVE_ENV: ReadonlyArray<readonly [string, string]> = [
  ["PAGER", "cat"],
  ["GIT_PAGER", "cat"],
  ["GIT_EDITOR", "true"],
  ["GIT_TERMINAL_PROMPT", "0"],
  ["DEBIAN_FRONTEND", "noninteractive"],
  ["AWS_PAGER", ""],
];

export function nonInteractiveShellPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const exports = NONINTERACTIVE_ENV.map(([name, def]) =>
    def === "" ? `export ${name}="\${${name}-}"` : `export ${name}="\${${name}:-${def}}"`,
  ).join("; ");
  const identity: Record<string, string> = {};
  for (const role of ["AUTHOR", "COMMITTER"]) {
    const name = env[`FLY_RESIDENT_ENV_GIT_${role}_NAME`];
    const email = env[`FLY_RESIDENT_ENV_GIT_${role}_EMAIL`];
    if (name === undefined && email === undefined) continue;
    if (!name?.trim() || !email?.trim())
      throw new Error(`Sandbox Git ${role.toLowerCase()} identity requires both NAME and EMAIL`);
    identity[`GIT_${role}_NAME`] = name;
    identity[`GIT_${role}_EMAIL`] = email;
  }
  if (identity.GIT_AUTHOR_NAME && !identity.GIT_COMMITTER_NAME) {
    identity.GIT_COMMITTER_NAME = identity.GIT_AUTHOR_NAME;
    identity.GIT_COMMITTER_EMAIL = identity.GIT_AUTHOR_EMAIL!;
  }
  const gitExports = Object.entries(identity)
    .map(([key, value]) => `export ${key}=${shq(value)}; `)
    .join("");
  return `exec </dev/null; ${exports}; ${gitExports}`;
}

export const DROPPED_PROXY_ENV = new Set([
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "all_proxy",
  "no_proxy",
  "NO_PROXY",
]);

export function forceThroughProxyEnv(egressProxyUrl: string, token: string): Record<string, string> {
  const u = new URL(egressProxyUrl);
  const url = `${u.protocol}//x:${token}@${u.host}`;
  const noProxy = "localhost,127.0.0.1,::1";
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    NO_PROXY: noProxy,
    https_proxy: url,
    http_proxy: url,
    no_proxy: noProxy,
  };
}

export function proxyExportPrefix(handle: SandboxHandle): string {
  const picked = Object.entries(handle.env ?? {}).filter(([key]) => DROPPED_PROXY_ENV.has(key));
  if (!picked.length) return "";
  return picked.map(([k, v]) => `export ${k}=${shq(v)}`).join("; ") + "; ";
}
