import fs from "node:fs";
import path from "node:path";

const WORD_START = String.raw`(^|[\s;&|()\{}!"'\u0060\\])(\S*/)?`;

export const BASELINE = [
  {
    pattern: String.raw`${WORD_START}rm\s+(-\S+\s+)*(/|/\*|~|~/|~/\*|\$HOME/?|\$HOME/\*|\$\{HOME\}/?|\$\{HOME\}/\*)(\s|$|[;&|)"'\u0060])`,
    reason: "deletes the root or home directory",
  },
  { pattern: String.raw`${WORD_START}mkfs(\.\w+)?\s`, reason: "formats a filesystem" },
  {
    pattern: String.raw`\bdd\b[^|;&]*\bof=/dev/(sd|hd|vd|xvd|nvme|mmcblk|disk|mapper/)`,
    reason: "writes to a raw disk",
  },
  { pattern: String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, reason: "is a fork bomb" },
];

export function compile(rules) {
  return rules.map((rule) => ({ ...rule, regex: new RegExp(rule.pattern, "i") }));
}

export function blockedReason(input, rules) {
  if (input?.tool_name !== "Bash") return null;
  const command = String(input.tool_input?.command ?? "")
    .replace(/\\\r?\n/g, " ")
    .replace(/[ \t]+/g, " ");
  const hit = rules.find((rule) => rule.regex.test(command));
  return hit ? `this command ${hit.reason ?? `matches the deny rule ${hit.pattern}`}` : null;
}

function main() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const configured = JSON.parse(fs.readFileSync(path.join(here, "guard.json"), "utf8")).deny ?? [];
  const reason = blockedReason(JSON.parse(fs.readFileSync(0, "utf8")), compile([...BASELINE, ...configured]));
  if (reason) process.stdout.write(reason);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
