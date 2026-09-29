import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  navigationIntent,
  observe,
  requiredResponsesComplete,
  sidebarRequirements,
  validateSidebarEvidence,
  waitSidebarReady,
} from "./run.mjs";
import { sha256 } from "./verify.mjs";

test("sidebar page evidence matches independent contents and the exact predecessor cursor across phases", () => {
  const path = "/api/session-navigation";
  const allRows = Array.from({ length: 51 }, (_, i) => ({ id: `s${i}` }));
  const spec = {
    transport: "navigation-post",
    surface: "web",
    recent: { total: 51, allRows },
    pinned: { total: 0, rows: [] },
    groups: { total: 1, items: [{ scopeId: "personal" }] },
    allowedOffPageRows: [{ id: "s50", threadRef: "web:actor:known" }],
  };
  const page = (rows, total, nextCursorSha256 = null) => ({
    idsSha256: sha256(JSON.stringify(rows)),
    count: rows.length,
    total,
    nextCursorSha256,
  });
  const first = {
    path,
    sameOrigin: true,
    method: "POST",
    completed: true,
    status: 200,
    navigation: navigationIntent(path, JSON.stringify({ surface: "web" })),
    navigationPages: {
      recent: page(
        allRows.slice(0, 50).map((row) => row.id),
        51,
        sha256("continuation"),
      ),
      pinned: page([], 0),
      groups: page(["personal"], 1),
    },
  };
  const second = {
    ...first,
    navigation: navigationIntent(path, JSON.stringify({ surface: "web", section: "recent", cursor: "continuation" })),
    navigationPages: { ...first.navigationPages, recent: page(["s50"], 51) },
  };
  const evidence = (requests) => ({ errors: [], requests });
  assert.doesNotThrow(() => validateSidebarEvidence(evidence([first]), spec));
  assert.doesNotThrow(() => validateSidebarEvidence(evidence([second]), spec, [first]));
  const requirements = sidebarRequirements(spec, { optional: true, cursorSha256: sha256("continuation") });
  assert.equal(requiredResponsesComplete([second], requirements), true);
  assert.equal(requiredResponsesComplete([first], requirements), false);
  assert.equal(requiredResponsesComplete([], requirements), false);
  assert.equal(requiredResponsesComplete([], sidebarRequirements(spec, { optional: true })), true);
  assert.equal(requiredResponsesComplete([], sidebarRequirements(spec)), false);
  for (const mutate of [
    (row) => {
      row.navigation.cursorSha256 = sha256("unseen");
    },
    (row) => {
      row.navigationPages.recent.idsSha256 = sha256(JSON.stringify(["s49"]));
    },
    (row) => {
      row.navigationPages.recent.total = 50;
    },
    (row) => {
      row.navigationPages.recent.nextCursorSha256 = sha256("stale");
    },
    (row) => {
      row.navigationPages.groups.idsSha256 = sha256(JSON.stringify(["foreign"]));
    },
    (row) => {
      row.navigation.references = [{ kind: "id", valueSha256: sha256("foreign") }];
    },
    (row) => {
      row.navigation.surface = "all";
    },
    (row) => {
      delete row.navigationPages;
    },
  ]) {
    const wrong = structuredClone(second);
    mutate(wrong);
    assert.throws(() => validateSidebarEvidence(evidence([wrong]), spec, [first]));
  }
  assert.throws(() => validateSidebarEvidence(evidence([second]), spec), /predecessor/);
  assert.throws(
    () => validateSidebarEvidence(evidence([first, { path: "/api/sessions", sameOrigin: true }]), spec),
    /fell back/,
  );
  assert.deepEqual(sidebarRequirements({ transport: "legacy-get" }), [
    { path: "/api/sessions", optional: false },
    { path: "/api/contexts", optional: false },
  ]);
  assert.doesNotThrow(() =>
    validateSidebarEvidence(evidence([{ path: "/api/sessions", sameOrigin: true }]), { transport: "legacy-get" }),
  );
});

test("navigation evidence hashes continuation identity and rejects malformed successful page envelopes", async () => {
  const origin = "http://127.0.0.1:8129",
    path = "/api/session-navigation";
  const body = JSON.stringify({ surface: "web" });
  const requirement = { path, method: "POST", navigation: navigationIntent(path, body), captureNavigation: true };
  const valid = {
    recent: { items: [{ id: "private-session" }], total: 2, nextCursor: "private-cursor" },
    pinned: { items: [], total: 0, nextCursor: null },
    groups: { items: [{ scopeId: "private-group" }], total: 1, nextCursor: null },
  };
  for (const malformed of [false, true]) {
    const page = new EventEmitter();
    const observer = observe(page, origin, [requirement]);
    observer.start();
    const request = {
      url: () => origin + path,
      method: () => "POST",
      postData: () => body,
      resourceType: () => "fetch",
      timing: () => ({}),
      sizes: async () => ({ responseBodySize: 2 }),
    };
    page.emit("request", request);
    page.emit("response", {
      request: () => request,
      status: () => 200,
      fromServiceWorker: () => false,
      allHeaders: async () => ({}),
      json: async () => (malformed ? { ...valid, groups: { ...valid.groups, total: false } } : valid),
    });
    page.emit("requestfinished", request);
    if (malformed) await assert.rejects(observer.waitResponses(10), /Required page requests/);
    else await observer.waitResponses(100);
    const evidence = await observer.finish();
    if (malformed)
      assert.deepEqual(evidence.errors, [{ type: "contract", path, message: "Invalid navigation page envelope" }]);
    else {
      assert.deepEqual(evidence.errors, []);
      assert.match(evidence.requests[0].navigationPages.recent.nextCursorSha256, /^[a-f0-9]{64}$/);
      assert.equal(evidence.requests[0].navigationPages.groups.nextCursorSha256, null);
    }
    assert.equal(JSON.stringify(evidence).includes("private-"), false);
  }
});

test("sidebar readiness checks populated grouped content, continuations and retained rows in a real browser", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(100);
    const allRows = Array.from({ length: 51 }, (_, i) => ({
      id: `s${i}`,
      title: `Chat ${i}`,
      groupedTitle: `Chat ${i}`,
      scopeId: i % 2 ? "standalone" : "personal",
    }));
    const groups = [
      { scopeId: "personal", name: "Personal", count: 26 },
      { scopeId: "empty", name: "Empty project", count: 0 },
    ];
    const spec = {
      schemaVersion: 1,
      surface: "web",
      transport: "navigation-post",
      sourceRevision: "a".repeat(40),
      recent: { total: 51, allRows },
      pinned: { total: 1, rows: [{ id: "pin", title: "Pinned chat" }], hasMore: false },
      groups: { total: 2, items: groups, hasMore: false },
      archivedCount: 3,
      allowedOffPageRows: [allRows[50]],
    };
    const row = (item) =>
      `<div class="session-row" data-session-id="${item.id}"><a class="session" aria-busy="false"><span class="tl">${item.title}</span></a></div>`;
    const html = ({ limit = 50, retained = false, legacy = false } = {}) => {
      const rows = allRows.filter((_, i) => i < limit || (retained && i === 50));
      return `<div id="sidebar-body" data-session-navigation="ready" data-session-navigation-mode="bounded" data-session-navigation-pending="" aria-busy="false"
        data-session-recent-loaded="${Math.min(limit, 51)}" data-session-recent-total="51" data-session-pinned-loaded="1" data-session-pinned-total="1" data-session-groups-loaded="2" data-session-groups-total="2">
        <div class="pinned-children">${row({ id: "pin", title: "Pinned chat" })}</div>
        ${groups
          .map(
            (group) =>
              `<section class="recent-project" ${legacy ? "" : `data-scope-id="${group.scopeId}"`}><span class="recent-project-name">${group.name}</span><span class="recent-project-count">${group.count}</span><div class="recent-project-menu"><button data-menu-id="project:${group.scopeId}">Options</button></div>${rows
                .filter((item) => item.scopeId === group.scopeId)
                .map(row)
                .join("")}</section>`,
          )
          .join("")}
        ${rows
          .filter((item) => item.scopeId === "standalone")
          .map(row)
          .join("")}
        ${limit < 51 ? '<button data-session-page="recent">Show more conversations</button>' : ""}<span class="archived-count">3</span></div>`;
    };
    await page.setContent(html());
    assert.equal((await waitSidebarReady(page, spec)).recent.length, 50);
    for (const mutation of [
      () => globalThis.document.querySelector('[data-session-id="s0"]').remove(),
      () => {
        globalThis.document.querySelector('[data-session-id="s0"] .tl').textContent = "Stale title";
      },
      () => {
        globalThis.document.querySelector(".recent-project-count").textContent = "25";
      },
      () => {
        globalThis.document.querySelector("#sidebar-body").dataset.sessionNavigation = "loading";
      },
      () => {
        globalThis.document.querySelector("#sidebar-body").dataset.sessionNavigationMode = "legacy";
      },
      () => {
        globalThis.document.querySelector("#sidebar-body").dataset.sessionRecentLoaded = "51";
      },
      () => {
        globalThis.document.querySelector('[data-session-page="recent"]').disabled = true;
      },
      () => {
        globalThis.document
          .querySelector('[data-session-id="s2"]')
          .before(globalThis.document.querySelector('[data-session-id="s4"]'));
      },
    ]) {
      await page.setContent(html());
      await page.evaluate(mutation);
      await assert.rejects(waitSidebarReady(page, spec), /Timeout/);
    }
    await page.setContent(html({ retained: true }));
    await assert.rejects(waitSidebarReady(page, spec), /Timeout/);
    assert.equal((await waitSidebarReady(page, spec, { retainedIds: ["s50"] })).recent.length, 51);
    await assert.rejects(waitSidebarReady(page, spec, { retainedIds: ["foreign"] }), /Unobserved retained/);
    await page.setContent(html({ limit: 100 }));
    assert.equal((await waitSidebarReady(page, spec, { limit: 100 })).recent.length, 51);
    await page.setContent(html({ legacy: true }));
    await page.locator("#sidebar-body").evaluate((root) => {
      for (const key of Object.keys(root.dataset)) delete root.dataset[key];
    });
    assert.equal((await waitSidebarReady(page, { ...spec, transport: "legacy-get" })).recent.length, 50);
    spec.pinned.rows[0].title = "2 alice,\u00a0bob";
    for (const transport of ["legacy-get", "navigation-post"]) {
      await page.setContent(
        html({ legacy: transport === "legacy-get" }).replace(
          "Pinned chat",
          "<span>2</span>\n    <span>alice,\u00a0bob</span>",
        ),
      );
      assert.equal((await waitSidebarReady(page, { ...spec, transport })).pinned[0].title, "2 alice,\u00a0bob");
      await page.locator(".pinned-children .tl").evaluate((element) => {
        element.textContent = "2 alice, bob";
      });
      await assert.rejects(waitSidebarReady(page, { ...spec, transport }), /Timeout/);
    }
  } finally {
    await browser.close();
  }
});

test("only a later successful identical navigation can supersede an explicitly admitted abort", () => {
  const path = "/api/session-navigation";
  const navigation = navigationIntent(path, JSON.stringify({ surface: "web", section: "recent" }));
  const requirement = { path, method: "POST", navigation, allowSupersededAbort: true };
  const done = { path, method: "POST", navigation, completed: true, status: 200 };
  const aborted = { ...done, completed: false, status: undefined, phase: "failed", failure: "net::ERR_ABORTED" };
  assert.equal(requiredResponsesComplete([aborted, done], [requirement]), true);
  for (const requests of [
    [done, aborted],
    [aborted],
    [aborted, { ...done, completed: false }],
    [aborted, { ...done, status: 403 }],
    [{ ...aborted, status: 500 }, done],
    [{ ...aborted, failure: "net::ERR_CONNECTION_RESET" }, done],
    [{ ...aborted, phase: "started" }, done],
    [aborted, { ...done, navigation: { ...navigation, cursorSha256: "different-page" } }],
  ])
    assert.equal(requiredResponsesComplete(requests, [requirement]), false);
  assert.equal(requiredResponsesComplete([aborted, done], [{ ...requirement, allowSupersededAbort: false }]), false);
  assert.equal(
    requiredResponsesComplete([aborted, done], [{ path, method: "POST", allowSupersededAbort: true }]),
    false,
  );
  const partial = { ...requirement, navigation: { surface: "web" } };
  assert.equal(
    requiredResponsesComplete(
      [aborted, { ...done, navigation: { ...navigation, cursorSha256: "different-page" } }],
      [partial],
    ),
    false,
  );
});

test("preparation evidence survives changing the measured request requirements", async () => {
  const page = new EventEmitter();
  const origin = "http://127.0.0.1:8129";
  const observer = observe(page, origin, [{ path: "/prepared" }]);
  const emit = (path) => {
    const request = {
      url: () => origin + path,
      method: () => "GET",
      resourceType: () => "fetch",
      timing: () => ({}),
      sizes: async () => ({ responseBodySize: 2 }),
    };
    page.emit("request", request);
    page.emit("response", {
      request: () => request,
      status: () => 200,
      fromServiceWorker: () => false,
      allHeaders: async () => ({}),
    });
    page.emit("requestfinished", request);
  };
  observer.start();
  emit("/prepared");
  await observer.waitResponses(100);
  const prepared = await observer.finish();
  observer.start([{ path: "/action" }]);
  await assert.rejects(observer.waitResponses(10), /\/action/);
  emit("/action");
  await observer.waitResponses(100);
  const measured = await observer.finish();
  assert.deepEqual(
    prepared.requests.map((entry) => entry.path),
    ["/prepared"],
  );
  assert.deepEqual(
    measured.requests.map((entry) => entry.path),
    ["/action"],
  );
  assert.ok(prepared.requests[0].completed && measured.requests[0].completed);
});

test("identity belongs to its phase and malformed current responses cannot inherit a prepared identity", async () => {
  const origin = "http://127.0.0.1:8129";
  const page = new EventEmitter();
  const observer = observe(page, origin, [{ path: "/me" }]);
  const send = (json = async () => ({ principal: "actor" }), path = "/me", status = 200) => {
    const request = {
      url: () => origin + path,
      method: () => "GET",
      resourceType: () => "fetch",
      timing: () => ({}),
      sizes: async () => ({ responseBodySize: 2 }),
    };
    page.emit("request", request);
    page.emit("response", {
      request: () => request,
      status: () => status,
      fromServiceWorker: () => false,
      allHeaders: async () => ({}),
      json,
    });
    page.emit("requestfinished", request);
  };
  const prepare = async () => {
    observer.start([{ path: "/me" }]);
    send();
    await observer.waitResponses(100);
    const evidence = await observer.finish();
    assert.equal(evidence.identity, "actor");
    assert.deepEqual(evidence.errors, []);
  };
  await prepare();
  observer.start([], { reuseIdentity: true });
  assert.equal((await observer.finish()).identity, "actor");
  observer.start([]);
  assert.equal((await observer.finish()).identity, undefined);
  assert.throws(() => observer.start([], { reuseIdentity: true }), /No verified identity/);
  for (const json of [
    async () => null,
    async () => ({}),
    async () => ({ user: "  " }),
    async () => ({ principal: { id: "actor" } }),
    async () => ({ principal: false, user: "actor" }),
    async () => {
      throw new SyntaxError("Private malformed response");
    },
  ]) {
    await prepare();
    observer.start([{ path: "/me" }], { reuseIdentity: true });
    send(json);
    await observer.waitResponses(100);
    const evidence = await observer.finish();
    assert.equal(evidence.identity, undefined);
    assert.deepEqual(evidence.errors, [{ type: "contract", path: "/me", message: "Invalid identity response" }]);
  }
  await prepare();
  observer.start([{ path: "/admin/api/me" }]);
  send(async () => ({ user: "wrong-actor" }), "/admin/api/me");
  await observer.waitResponses(100);
  assert.equal((await observer.finish()).identity, "wrong-actor");
  await prepare();
  observer.start([], { reuseIdentity: true });
  send(undefined, "/me", 401);
  const denied = await observer.finish();
  assert.equal(denied.identity, undefined);
  assert.deepEqual(denied.errors, [{ type: "http", path: "/me", status: 401 }]);
  for (const nextPhase of [false, true]) {
    observer.start([]);
    const delayed = Promise.withResolvers();
    send(() => delayed.promise);
    if (nextPhase) observer.start([]);
    send(async () => ({ user: "latest-actor" }));
    delayed.resolve({ user: "old-actor" });
    const evidence = await observer.finish();
    assert.equal(evidence.identity, "latest-actor");
    assert.deepEqual(evidence.errors, []);
  }
  observer.start([]);
  const old = Promise.withResolvers();
  send(() => old.promise);
  observer.start([]);
  send();
  old.reject(new SyntaxError("Old phase"));
  const evidence = await observer.finish();
  assert.equal(evidence.identity, "actor");
  assert.deepEqual(evidence.errors, []);
});

test("observer retains pending and failed starts without mixing measurement generations", async () => {
  const page = new EventEmitter();
  const origin = "http://127.0.0.1:8129";
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const request = (path, options = {}) => ({
    url: () => origin + path,
    method: () => "GET",
    resourceType: () => "fetch",
    timing: () => ({ startTime: 1000 }),
    sizes: async () => ({ responseBodySize: 2 }),
    failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
    ...options,
  });
  const response = (req, options = {}) => ({
    request: () => req,
    status: () => 200,
    fromServiceWorker: () => false,
    json: async () => ({ principal: "current@example.invalid" }),
    allHeaders: async () => ({ "content-type": "application/json" }),
    ...options,
  });
  const observer = observe(
    page,
    origin,
    ["/done", "/pending", "/missing", "/failed"].map((path) => ({ path })),
  );
  observer.start();
  const oldIdentity = deferred();
  const oldHeaders = deferred();
  const oldSizes = deferred();
  const previousMe = request("/me");
  const previousDone = request("/done", { sizes: () => oldSizes.promise });
  const previousMissing = request("/missing");
  for (const req of [previousMe, previousDone, previousMissing]) page.emit("request", req);
  page.emit("response", response(previousMe, { json: () => oldIdentity.promise }));
  page.emit("response", response(previousDone, { allHeaders: () => oldHeaders.promise }));
  page.emit("requestfinished", previousDone);

  observer.start();
  const done = request("/done?private=secret-query");
  const completedDuplicate = request("/pending");
  const pending = request("/pending");
  const failed = request("/failed");
  const me = request("/me");
  for (const req of [done, completedDuplicate, pending, failed, me]) page.emit("request", req);
  for (const req of [done, completedDuplicate, me]) {
    page.emit("response", response(req));
    page.emit("requestfinished", req);
  }
  page.emit("requestfailed", failed);
  page.emit("response", response(previousMissing));
  page.emit("requestfinished", previousMissing);
  oldIdentity.resolve({ principal: "previous@example.invalid" });
  oldHeaders.reject(new Error("Previous measurement headers failed"));
  oldSizes.resolve({ responseBodySize: 999 });

  await assert.rejects(observer.waitResponses(10), {
    message: "Required page requests did not finish: /pending, /missing, /failed",
  });
  const evidence = await observer.finish();
  assert.equal(evidence.identity, "current@example.invalid");
  assert.equal(evidence.requests.length, 5);
  assert.equal(
    evidence.requests.some((entry) => entry.path === "/missing"),
    false,
  );
  const duplicates = evidence.requests.filter((entry) => entry.path === "/pending");
  assert.equal(duplicates[0].completed, true);
  assert.equal(duplicates[0].phase, "finished");
  assert.equal(duplicates[1].completed, false);
  assert.equal(duplicates[1].phase, "started");
  assert.equal(duplicates[1].status, undefined);
  assert.ok(duplicates[1].pendingForMs >= 0);
  const failedEntry = evidence.requests.find((entry) => entry.path === "/failed");
  assert.equal(failedEntry.phase, "failed");
  assert.equal(failedEntry.failure, "net::ERR_CONNECTION_RESET");
  assert.equal(failedEntry.completed, false);
  assert.deepEqual(evidence.errors, [{ type: "requestfailed", path: "/failed", message: "net::ERR_CONNECTION_RESET" }]);
  assert.equal(JSON.stringify(evidence).includes("secret-query"), false);
});

test("navigation completion binds method, section, cursor, filters and ordered references without storing their text", async () => {
  const path = "/api/session-navigation/page";
  const body = {
    children: true,
    parentSessionId: "private-parent",
    query: "private-query",
    title: "private-title",
    cursor: "private-cursor",
  };
  const intent = navigationIntent(path, JSON.stringify(body));
  assert.deepEqual(intent, navigationIntent(path, JSON.stringify(Object.fromEntries(Object.entries(body).reverse()))));
  assert.equal(JSON.stringify(intent).includes("private-"), false);
  const referencePath = "/api/session-navigation/resolve";
  const refs = [
    { kind: "id", value: "private-a" },
    { kind: "thread", value: "private-b" },
  ];
  assert.notDeepEqual(
    navigationIntent(referencePath, JSON.stringify({ references: refs })),
    navigationIntent(referencePath, JSON.stringify({ references: [...refs].reverse() })),
  );
  for (const invalid of [
    null,
    [],
    { ...body, principalId: "forged" },
    { ...body, children: "true" },
    { ...body, cursor: "x".repeat(4097) },
  ])
    assert.throws(() => navigationIntent(path, JSON.stringify(invalid)));
  assert.throws(() => navigationIntent(referencePath, JSON.stringify({ references: Array(13).fill(refs[0]) })));
  const requirement = { path, method: "POST", navigation: intent };
  const entry = { path, method: "POST", navigation: intent, completed: true, status: 200 };
  assert.equal(requiredResponsesComplete([entry], [requirement]), true);
  for (const change of [
    { method: "GET" },
    { sameOrigin: false },
    { completed: false },
    { status: 500 },
    { navigation: { ...intent, cursorSha256: null } },
    { navigation: { ...intent, parentSessionIdSha256: null } },
  ])
    assert.equal(requiredResponsesComplete([{ ...entry, ...change }], [requirement]), false);
  assert.equal(requiredResponsesComplete([entry], [{ path }]), false);
  assert.equal(requiredResponsesComplete([entry, { ...entry, completed: false }], [requirement]), false);
  const initial = navigationIntent("/api/session-navigation", JSON.stringify({ surface: "web" }));
  assert.notDeepEqual(
    initial,
    navigationIntent("/api/session-navigation", JSON.stringify({ surface: "web", section: "pinned" })),
  );

  const page = new EventEmitter();
  const observer = observe(page, "http://127.0.0.1:8129", [requirement]);
  observer.start();
  const request = {
    url: () => "http://127.0.0.1:8129" + path,
    method: () => "POST",
    postData: () => JSON.stringify(body),
    resourceType: () => "fetch",
    timing: () => ({}),
    sizes: async () => ({ responseBodySize: 2 }),
  };
  page.emit("request", request);
  page.emit("response", {
    request: () => request,
    status: () => 200,
    fromServiceWorker: () => false,
    allHeaders: async () => ({}),
  });
  await assert.rejects(observer.waitResponses(5));
  page.emit("requestfinished", request);
  await observer.waitResponses(100);
  const evidence = await observer.finish();
  assert.deepEqual(evidence.errors, []);
  assert.deepEqual(evidence.requests[0].navigation, intent);
  assert.equal(JSON.stringify(evidence).includes("private-"), false);
});
