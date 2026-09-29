import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { projectScopeId } from "../src/projects/project-store.ts";
import { testConfig } from "./support/test-config.ts";

test("navigation reuses one authorized snapshot and preserves legacy list/context populations", async (t) => {
  const built = buildApp(testConfig());
  try {
    for (let i = 0; i < 63; i++) {
      const session = await built.sessions.getOrCreateByThread(`web:U1:${i}`, "dm", "personal:U1");
      await built.sessions.addParticipant(session.id, "U1");
      await built.sessions.updateTitle(session.id, `Visible ${i}`);
    }
    const hidden = await built.sessions.getOrCreateByThread("web:U1:hidden", "dm", "personal:U1");
    await built.sessions.addParticipant(hidden.id, "U1");
    const legacy = await built.app.listSessions("U1");
    const contexts = await built.app.listContexts("U1");
    const list = built.sessions.listByParticipant.bind(built.sessions);
    let reads = 0;
    t.mock.method(built.sessions, "listByParticipant", async (id: string) => {
      reads++;
      return list(id);
    });
    const navigation = await built.app.sessionNavigation("U1", { references: [{ kind: "id", value: hidden.id }] });
    assert.equal(reads, 1);
    assert.equal(navigation.recent.total, legacy.length);
    assert.equal(navigation.recent.items.length, 50);
    assert.equal(navigation.references[0]!.session?.id, hidden.id);
    assert.deepEqual(navigation.contexts, contexts);
    const page = await built.app.sessionPage("U1", {});
    assert.equal(reads, 2);
    assert.equal(page.total, 63);
    const next = await built.app.sessionPage("U1", { cursor: page.nextCursor! });
    assert.deepEqual(
      new Set([...page.items, ...next.items].map((row) => row.id)),
      new Set(legacy.map((row) => row.id)),
    );
    assert.deepEqual(await built.app.listSessions("U1"), legacy);
    assert.deepEqual(await built.app.listContexts("U1"), contexts);
    assert.equal(reads, 5);
  } finally {
    await built.runtime.stop();
  }
});

test("ID and thread resolution use participant and current project authorization without full enumeration", async (t) => {
  const built = buildApp(testConfig());
  try {
    const project = await built.projects.create({ name: "Current project", ownerId: "owner" });
    await built.projects.addMember(project.id, "owner", "member");
    const own = await built.sessions.getOrCreateByThread("web:member:project", "group", projectScopeId(project.id));
    await built.sessions.addParticipant(own.id, "member");
    await built.sessions.updateTitle(own.id, "Project row");
    const foreign = await built.sessions.getOrCreateByThread("web:other:foreign", "dm", "personal:other");
    await built.sessions.addParticipant(foreign.id, "other");
    const refs = [
      { kind: "id" as const, value: own.id },
      { kind: "thread" as const, value: own.threadRef },
      { kind: "id" as const, value: foreign.id },
      { kind: "thread" as const, value: foreign.threadRef },
      { kind: "id" as const, value: "missing" },
    ];
    const participantGet = built.sessions.getForParticipant.bind(built.sessions);
    const readIds: string[] = [];
    t.mock.method(built.sessions, "getForParticipant", async (id: string, principal: string) => {
      readIds.push(id);
      return participantGet(id, principal);
    });
    t.mock.method(built.sessions, "listByParticipant", async () => {
      throw new Error("unexpected full enumeration");
    });
    assert.deepEqual(
      (await built.app.resolveSessions("member", refs)).references.map((ref) => ref.session?.id ?? null),
      [own.id, own.id, null, null, null],
    );
    assert.deepEqual(new Set(readIds), new Set([own.id, foreign.id, "missing"]));
    assert.equal(readIds.length, 3);
    await built.projects.removeMember(project.id, "owner", "member");
    assert.ok((await built.app.resolveSessions("member", refs)).references.every((ref) => ref.session === null));
    t.mock.restoreAll();
    assert.equal((await built.app.sessionNavigation("member")).recent.total, 0);
    assert.equal((await built.app.sessionPage("member", { scopeId: projectScopeId(project.id) })).total, 0);
    assert.equal((await built.app.sessionNavigation("member", { references: refs })).references[0]!.session, null);
    await assert.rejects(built.app.resolveSessions("member", Array(13).fill(refs[0])), /too many session references/);
  } finally {
    await built.runtime.stop();
  }
});

test("finite-read aborts and query errors do not become empty successful navigation", async (t) => {
  const built = buildApp(testConfig());
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(built.app.sessionNavigation("U1", {}, cancelled.signal), { name: "AbortError" });
    await assert.rejects(built.app.sessionPage("U1", {}, cancelled.signal), { name: "AbortError" });
    await assert.rejects(built.app.resolveSessions("U1", [], cancelled.signal), { name: "AbortError" });
    const next = new AbortController();
    t.mock.method(built.sessions, "listByParticipant", async () => {
      next.abort();
      return [];
    });
    t.mock.method(built.crons, "list", async () => {
      throw new Error("should not continue after abort");
    });
    await assert.rejects(built.app.sessionPage("U1", {}, next.signal), { name: "AbortError" });
    t.mock.method(built.sessions, "listByParticipant", async () => {
      throw new Error("enumeration failed");
    });
    await assert.rejects(built.app.sessionNavigation("U1"), /enumeration failed/);
  } finally {
    await built.runtime.stop();
  }
});

test("abort during live-thread lookup prevents participant enumeration for navigation and page", async (t) => {
  const built = buildApp(testConfig());
  try {
    for (const method of ["sessionNavigation", "sessionPage"] as const) {
      const controller = new AbortController();
      let participantReads = 0;
      t.mock.method(built.runs, "activeSessionIds", async () => {
        controller.abort();
        return [];
      });
      t.mock.method(built.sessions, "listByParticipant", async () => {
        participantReads++;
        return [];
      });
      await assert.rejects(built.app[method]("U1", {}, controller.signal), { name: "AbortError" });
      assert.equal(participantReads, 0, method);
    }
  } finally {
    await built.runtime.stop();
  }
});
