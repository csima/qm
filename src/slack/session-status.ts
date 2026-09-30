import { SLACK_STATUS_BLOCK_PREFIX } from "./message-gating.ts";
import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { isTerminal, type RunStore } from "../runs/run-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { sessionTreeWorking } from "../sessions/session-syscalls.ts";
import { scopeId } from "../types.ts";
import { conversationWebUrl } from "../util/conversation-links.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";

export interface SlackSessionStatusState {
  writer?: string;
  account: string;
  channel: string;
  threadTs?: string;
  anchorRunId: string;
  startedAt?: number;
  cardId?: string;
  cardTs?: string;
  cardContent?: string;
  followUrl?: string;
}

interface StatusClient {
  apiCall(method: string, args: Record<string, unknown>): Promise<unknown>;
}


export function createSlackSessionStatus(
  store: DurableMap<SlackSessionStatusState>,
  lease: LeaderLease,
  runs: Pick<RunStore, "get" | "activeForThread">,
  sessions: Pick<SessionStore, "getByThread" | "childrenOf">,
  flags: Pick<FeatureFlagStore, "enabled">,
  publicWebUrl: string | undefined,
  now = Date.now,
) {
  if (!store.update || !store.deleteIf) throw new Error("Slack status requires atomic durable updates");
  const update = store.update.bind(store);
  const deleteIf = store.deleteIf.bind(store);
  const queue = createKeyedQueue<string>();
  const key = (account: string, channel: string, threadTs?: string) => JSON.stringify([account, channel, threadTs ?? ""]);
  async function sync(client: StatusClient, id: string, next?: SlackSessionStatusState) {
    await queue(id, async () => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const applied = await lease.hold(`slack:session-status:${id}`, async (lost) => {
          let leaseLost = false;
          void lost.then(() => {
            leaseLost = true;
          });
          const writer = randomUUID();
          const anchor = await runs.get((next ?? (await store.get(id)))?.anchorRunId ?? "");
          const optedIn =
            !!anchor && (await flags.enabled("responsive_spine", scopeId("personal", anchor.request.actor.id)));
          if (next && (!optedIn || anchor.request.privateSessionMessage || isTerminal(anchor.status))) return true;
          if (leaseLost) return true;
          if (next) await store.putIfAbsent(id, { ...next, writer });
          if (leaseLost) {
            await deleteIf(id, (row) => row.writer === writer && !row.cardTs);
            return true;
          }
          let state = await update(id, (row) =>
            leaseLost ? row : { ...row, writer, ...(next ? { anchorRunId: next.anchorRunId } : {}) },
          );
          if (!state || leaseLost || state.writer !== writer) return true;
          const persist = async (patch: Partial<SlackSessionStatusState>) => {
            const saved = await update(id, (row) => (!leaseLost && row.writer === writer ? { ...row, ...patch } : row));
            if (!saved || leaseLost || saved.writer !== writer) return false;
            state = saved;
            return true;
          };
          const session = anchor && optedIn ? await sessions.getByThread(anchor.sessionId) : null;
          const working =
            !!anchor &&
            optedIn &&
            (session
              ? await sessionTreeWorking(sessions, runs, session)
              : !!(await runs.activeForThread(anchor.sessionId)));
          state = { ...state, startedAt: state.startedAt ?? now(), cardId: state.cardId ?? randomUUID() };
          if (session) state.followUrl = conversationWebUrl(publicWebUrl, session.id);
          if (leaseLost) return true;
          if (!(await persist(state))) return true;
          const minutes = Math.floor((now() - state.startedAt!) / 60_000);
          try {
            if (!working || minutes < 1) {
              if (!working && state.cardTs) await client.apiCall("chat.delete", { channel: state.channel, ts: state.cardTs });
              if (!working) await deleteIf(id, (row) => !leaseLost && row.writer === writer);
              return true;
            }
            const title = `Still working (${minutes}m)`;
            const blocks = [
              {
                type: "context",
                block_id: `${SLACK_STATUS_BLOCK_PREFIX}${state.cardId}`,
                elements: [
                  {
                    type: "mrkdwn",
                    text: state.followUrl ? `${title} · <${state.followUrl}|View in QM>` : title,
                  },
                ],
              },
            ];
            const content = JSON.stringify(blocks);
            if (state.cardContent !== content) {
              const result = (await client.apiCall(state.cardTs ? "chat.update" : "chat.postMessage", {
                channel: state.channel,
                ...(state.cardTs
                  ? { ts: state.cardTs }
                  : { ...(state.threadTs ? { thread_ts: state.threadTs } : {}), client_msg_id: state.cardId }),
                text: title,
                blocks,
                unfurl_links: false,
                unfurl_media: false,
              })) as { ts?: string };
              const cardTs = state.cardTs ?? result.ts;
              if (!cardTs) throw new Error("Slack status message response missing timestamp");
              if (leaseLost) {
                await update(id, (row) => (row.cardId === state!.cardId && !row.cardTs ? { ...row, cardTs } : row));
                state = { ...state, cardTs };
                return true;
              }
              if (!(await persist({ cardTs, cardContent: content }))) return true;
            }
          } catch (error) {
            const code = (error as { data?: { error?: string } }).data?.error;
            if (
              [
                "channel_not_found",
                "not_authorized",
                "no_permission",
                "thread_ts_not_allowed",
                "message_not_found",
                "cant_delete_message",
              ].includes(code ?? "") &&
              !leaseLost
            )
              await deleteIf(id, (row) => !leaseLost && row.writer === writer);
            throw error;
          } finally {
            if (leaseLost) {
              await store.putIfAbsent(id, state);
              await update(id, (row) => ({ ...row, cardContent: undefined }));
            }
          }
          return true;
        });
        if (applied) return;
        await sleep(50);
      }
      throw new Error("Slack session status lock timed out");
    });
  }
  return {
    async start(client: StatusClient, account: string, runId: string, channel: string, threadTs?: string) {
      await sync(client, key(account, channel, threadTs), {
        account,
        channel,
        ...(threadTs ? { threadTs } : {}),
        anchorRunId: runId,
        startedAt: now(),
        cardId: randomUUID(),
      }).catch(swallowAs("slack: start session status", undefined));
    },
    async reconcile(client: StatusClient, account: string) {
      for (const [id, state] of await store.entries()) {
        if (state.account !== account) continue;
        await sync(client, id).catch(swallowAs("slack: reconcile session status", undefined));
      }
    },
  };
}

export type SlackSessionStatus = ReturnType<typeof createSlackSessionStatus>;
