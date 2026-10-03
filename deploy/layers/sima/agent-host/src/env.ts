import type { Instance } from "./instance.ts";

export interface Env {
  DB: D1Database;
  STATE: R2Bucket;
  INSTANCE: DurableObjectNamespace<Instance>;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_EMAILS: string;
  PUBLIC_URL: string;
  HOST_ADMIN_TOKEN?: string;
  CREDENTIALS_KEY: string;
  DEFAULT_ANTHROPIC_API_KEY?: string;
  DEFAULT_CLAUDE_CODE_OAUTH_TOKEN?: string;
}

export type Via = "access" | "api_key" | "admin_token" | "agent";

export interface Caller {
  email: string;
  via: Via;
  admin: boolean;
}

export interface Sharing {
  message: string[];
  attach: string[];
  admin: string[];
}

export interface InstanceRow {
  id: string;
  agent: string;
  version: string;
  owner: string;
  sharing: Sharing;
  size: string;
  status: string;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface Manifest {
  name: string;
  description: string;
  base: string;
  setup: string | null;
  harness: string;
  instance: string;
  credentials: { name: string; description: string; required: boolean }[];
}

export interface InstanceConfig {
  id: string;
  agent: string;
  version: string;
  harness: string;
  size: string;
  sessions: string[];
  credentials: string;
}
