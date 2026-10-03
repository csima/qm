import { MODEL_CREDENTIALS } from "../shared/naming.js";
import type { Env, InstanceConfig } from "./env.ts";

export function systemPrompt(config: Pick<InstanceConfig, "id" | "agent">, egress: string[] | null = null): string {
  return [
    `You are the ${config.agent} agent, running as agent-host instance ${config.id}.`,
    "Messages sent through the host start with a header line: [agent-host task <id> from <email> via <channel>]. The email is the person you are acting for. A channel of agent:<instance> means another agent sent it on that person's behalf.",
    "The agent repo at /agent is read-only. Write files under /home/agent/work.",
    'Other agents can help you. `agent-list` shows the ones you may call; `agent-call <instance> "<message>"` asks one and prints its reply (it acts for the same person and can take minutes, so run it with a Bash timeout of 600000 ms). If it says the agent is still working, run the `agent-call --wait <id>` it prints.',
    "The host blocks some commands. If a command is blocked, do not try to work around it; tell the person.",
    ...(egress
      ? [
          `Network access is limited to these hosts: ${egress.join(", ") || "(none besides the model API)"}. Requests anywhere else fail with 403.`,
        ]
      : []),
  ].join("\n");
}

export function modelEnvironment(
  env: Pick<Env, "DEFAULT_ANTHROPIC_API_KEY" | "DEFAULT_CLAUDE_CODE_OAUTH_TOKEN">,
  credentials: Record<string, string>,
): Record<string, string> {
  if (MODEL_CREDENTIALS.some((name) => credentials[name])) return {};
  if (env.DEFAULT_CLAUDE_CODE_OAUTH_TOKEN) return { CLAUDE_CODE_OAUTH_TOKEN: env.DEFAULT_CLAUDE_CODE_OAUTH_TOKEN };
  if (env.DEFAULT_ANTHROPIC_API_KEY) return { ANTHROPIC_API_KEY: env.DEFAULT_ANTHROPIC_API_KEY };
  throw new Error(
    "no model credentials: set DEFAULT_ANTHROPIC_API_KEY or DEFAULT_CLAUDE_CODE_OAUTH_TOKEN, or give the instance its own",
  );
}
