export const INSTANCE_ID = /^[a-z][a-z0-9-]{1,40}$/;
export const SESSION_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const INSTANCE_TYPES = ["lite", "standard-1", "standard-2", "standard-3", "standard-4"];
export const MODEL_CREDENTIALS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

export function imageKey(agent, version) {
  return `${agent}--${version}`;
}
