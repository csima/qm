import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_VIEWS,
  WEB_VIEWS,
  ATTACHMENT,
  buildCatalog,
  cellsFor,
  declaredDisabled,
  multiviewState,
  secondaryRequests,
} from "./catalog.mjs";
import { deriveSidebarReadiness, deriveViewFixtures } from "./fixture-views.mjs";
import {
  establishSplitState,
  requiredResponsesComplete,
  validateConfig,
  validateReadySpec,
  waitReady,
} from "./run.mjs";
import {
  medianUpperBound,
  quantile,
  summarizeCell,
  validateQualification,
  verifyCampaign,
  verifyRun,
} from "./verify.mjs";

const observations = (durationMs = 600, count = 31) =>
  Array.from({ length: count }, (_, iteration) => ({
    cellId: "chat:cold:normal",
    iteration,
    status: "pass",
    durationMs,
    startedAt: 1000 + iteration,
    finishedAt: 1600 + iteration,
    errors: [],
    readiness: { passed: true },
  }));
const run = {
  runId: "candidate",
  mode: "diagnostic",
  status: "completed",
  samplesPerCell: 31,
  thresholdMs: 1000,
  requiredCells: ["chat:cold:normal"],
  measurementStartedAt: 1000,
  measurementFinishedAt: 2000,
};

test("exact one-sided median bound does not confuse sample median with confidence", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(medianUpperBound(Array.from({ length: 31 }, (_, i) => i + 1)), 21);
  assert.equal(medianUpperBound([1, 2, 3]), null);
  const marginal = [...Array(16).fill(900), ...Array(15).fill(1400)].map((durationMs) => ({
    status: "pass",
    durationMs,
  }));
  assert.equal(summarizeCell(marginal).medianMs, 900);
  assert.equal(summarizeCell(marginal).pass, false);
  assert.equal(summarizeCell(observations(999)).pass, true);
  assert.equal(summarizeCell(observations(1000)).pass, false);
});

test("family-wide correction raises the confidence bar and retains all failures", () => {
  const data = observations().map((sample, i) => ({ ...sample, durationMs: i < 23 ? 700 : 1500 }));
  assert.equal(summarizeCell(data, { alpha: 0.05 }).pass, true);
  assert.equal(summarizeCell(data, { alpha: 0.0005 }).pass, false);
  const failed = observations();
  failed[0] = { ...failed[0], status: "failed", durationMs: 15_000 };
  assert.equal(summarizeCell(failed).pass, false);
  assert.equal(summarizeCell(failed).failures, 1);
});

test("verifier rejects missing, duplicate, unexpected and incomplete observations", () => {
  assert.equal(verifyRun(run, observations(), {}).pass, true);
  assert.equal(verifyRun(run, observations().slice(1), {}).pass, false);
  assert.equal(verifyRun(run, [...observations(), observations()[0]], {}).pass, false);
  assert.equal(
    verifyRun(
      run,
      observations().map((sample) => ({ ...sample, cellId: "different" })),
      {},
    ).pass,
    false,
  );
  assert.equal(
    verifyRun(
      run,
      observations().map((sample) => ({ ...sample, readiness: undefined })),
      {},
    ).pass,
    false,
  );
  assert.equal(
    verifyRun(
      run,
      observations().map((sample) => ({ ...sample, errors: [{ status: 500 }] })),
      {},
    ).pass,
    false,
  );
});

test("local diagnostics cannot qualify even when every sample is fast", () => {
  const result = verifyRun(run, observations(), { scale: 0.001, qualified: false });
  assert.equal(result.pass, true);
  assert.equal(result.qualified, false);
  assert.ok(result.qualificationReasons.includes("Diagnostic runs cannot qualify"));
  assert.ok(result.qualificationReasons.some((reason) => reason.includes("full-scale")));
});

test("parity must include database working-set, network and workload interval evidence", () => {
  const reasons = validateQualification(
    { ...run, mode: "qualifying" },
    { scale: 1, qualified: true },
    { isolated: true },
    { pass: true },
  );
  for (const text of [
    "database-working-set",
    "client-network",
    "entire browser measurement interval",
    "Verified table counts",
  ])
    assert.ok(reasons.some((reason) => reason.includes(text)));
});

test("catalog never omits unsupported fixture cases and uses supported admin routes", () => {
  const catalog = buildCatalog({});
  assert.ok(catalog.every((scenario) => scenario.missing.length > 0));
  const ids = catalog.map((scenario) => scenario.id);
  for (const id of [
    "web.root.max",
    "web.chat.dense",
    "web.sidebar.more",
    "web.multiview.restore",
    "web.multiview.hidden-return",
    "admin.scopes",
    "admin.history.next",
    "admin.transcript.long",
    "admin.spend.90d",
  ])
    assert.ok(ids.includes(id));
  assert.ok(ADMIN_VIEWS.every((view) => ids.includes(`admin.${view}`)));
  assert.ok(WEB_VIEWS.every((view) => ids.includes(`web.${view}`)));
  assert.equal(catalog.length, 60);
  assert.equal(cellsFor(catalog, "normal").length, 109);
  for (const name of ["legacy", "mixed"])
    assert.deepEqual(catalog.find((row) => row.id === `web.chat.${name}`).modes, ["cold", "warm"]);
  assert.equal(catalog.find((row) => row.id === "web.deploys").path, "/apps");
  assert.equal(catalog.find((row) => row.id === "web.attachment.stage").ready[1].texts[0], ATTACHMENT.name);
  assert.ok(!ids.includes("web.calendar"));
  assert.ok(!ids.includes("admin.metrics") && !ids.includes("admin.live"));
  const cells = cellsFor(catalog, "peak");
  assert.equal(new Set(cells.map((cell) => cell.id)).size, cells.length);
});

test("web surface readiness requires populated observed rows and follows account feature permissions", () => {
  const fixture = {
    fixtureId: "fixture",
    orgScopeId: "org:fixture",
    adminPrincipalId: "actor",
    cases: { short: { principalId: "actor" } },
    cohorts: { max: { principalId: "actor" } },
  };
  const responses = {
    "/admin/api/me": { principal: "actor", scopeId: "org:fixture", isAdmin: true },
    "/admin/api/scopes": { scopeId: "org:fixture", scopes: [] },
    "/me": { user: "actor", permissions: ["loops", "inbox"] },
    "/api/sessions": { sessions: [{ id: "session", threadRef: "web:session", surface: "web", createdAt: 1 }] },
    "/api/contexts": {
      contexts: [{ scopeId: "group:fixture", kind: "group", project: { name: "Synthetic project" }, sessionCount: 3 }],
    },
    "/api/crons": { crons: [{ id: "cron", title: "Synthetic cron", enabled: false }] },
    "/api/webhooks": { webhooks: [{ action: "Synthetic webhook action", enabled: false }] },
    "/api/loops": { loops: [{ name: "Synthetic paused loop" }] },
    "/api/inbox": {
      migrationPending: false,
      nextCursor: null,
      items: [{ id: "item", state: "held", sourcePayload: { snippet: "Synthetic review item" } }],
    },
    "/api/inbox?view=handled": { items: [] },
    "/api/files?limit=60": { owned: [{ name: "Synthetic file one" }], shared: [{ name: "Synthetic file two" }] },
    "/api/keychain/overview": { credentials: [{ service: "Synthetic credential" }] },
    "/api/connectors": { providers: {} },
    "/api/deployments": {
      deployments: [
        { name: "Synthetic own app", ownerScopeId: "personal:actor", status: "paused" },
        { name: "Not on Yours", ownerScopeId: "personal:someone", status: "paused" },
      ],
    },
    "/api/memory": { content: "- (2026-09-25) Synthetic fact one\n- Synthetic fact two" },
    "/api/skills?includeShadowed=1": {
      skills: [
        { description: "Synthetic active skill", status: "active" },
        { description: "Archived", status: "archived" },
      ],
    },
  };
  const evidence = {
    fixtureId: "fixture",
    rows: Object.entries(responses).map(([path, data]) => ({ path, principalId: "actor", status: 200, data })),
  };
  const derived = deriveViewFixtures(fixture, evidence);
  for (const view of WEB_VIEWS) {
    assert.ok(derived.views[`web.${view}`], `Missing ${view}`);
    const scenario = buildCatalog(derived).find((row) => row.id === `web.${view}`);
    assert.deepEqual(scenario.missing, ["browser.sidebarReadiness"]);
    assert.doesNotThrow(() => validateReadySpec(scenario.ready));
  }
  assert.equal(derived.views["web.files"].rows.minimum, 2);
  assert.equal(derived.views["web.deploys"].rows.minimum, 1);
  assert.deepEqual(derived.views["web.memory"].values, [
    { selector: "textarea.memory-text", value: responses["/api/memory"].content },
  ]);
  assert.equal(derived.views["web.memory"].editable, "textarea.memory-text");
  assert.deepEqual(derived.views["web.memory"].absentTexts, ["Loading…"]);
  assert.equal(derived.views["web.memory"].rows, undefined);
  assert.equal(derived.views["web.memory.facts"].rows.minimum, 2);
  const factsScenario = buildCatalog(derived).find((row) => row.id === "web.memory.facts");
  assert.deepEqual(factsScenario.missing, ["browser.sidebarReadiness"]);
  assert.deepEqual(factsScenario.modes, ["warm"]);
  assert.equal(factsScenario.prepareReady.editable, "textarea.memory-text");
  assert.doesNotThrow(() => validateReadySpec(factsScenario.ready));
  assert.equal(derived.views["web.skills"].rows.minimum, 1);
  assert.deepEqual(derived.views["web.crons.disabled"].expectedText, ["Synthetic cron"]);
  assert.ok(derived.browser.exclusions.some((row) => row.id === "web.calendar"));
  const empty = structuredClone(evidence);
  empty.rows.find((row) => row.path === "/api/files?limit=60").data = { owned: [], shared: [] };
  const incomplete = deriveViewFixtures(fixture, empty);
  assert.equal(incomplete.views["web.files"], undefined);
  assert.ok(buildCatalog(incomplete).find((row) => row.id === "web.files").missing.length);
  const disabled = structuredClone(evidence);
  disabled.rows.find((row) => row.path === "/me").data.permissions = [];
  const disabledFixture = deriveViewFixtures(fixture, disabled);
  for (const feature of ["loops", "inbox"]) {
    assert.equal(declaredDisabled(disabledFixture.browser.features[feature]), true);
    const scenario = buildCatalog(disabledFixture).find((row) => row.id === `web.${feature}`);
    assert.equal(scenario.ready.root, "body");
    assert.deepEqual(
      scenario.requiredResponses.map((row) => row.path),
      ["/me"],
    );
    assert.doesNotThrow(() => validateReadySpec(scenario.ready));
  }
  const stale = structuredClone(disabled);
  delete stale.rows.find((row) => row.path === "/me").data.permissions;
  assert.equal(deriveViewFixtures(disabledFixture, stale).views["web.loops"], undefined);
});

test("mixed earlier-page readiness proves a nonempty crossing after bounded preparation", () => {
  const fixture = {
    fixtureId: "fixture",
    orgScopeId: "org:fixture",
    adminPrincipalId: "actor",
    cases: {
      mixed: {
        sessionId: "mixed",
        principalId: "actor",
        expectedVisibleText: "Last synthetic entry",
        messageCount: 220,
        transcriptBoundarySeq: 150,
      },
    },
  };
  const user = (seq, text) => ({ seq, type: "user", payload: { text } });
  const evidence = {
    fixtureId: "fixture",
    rows: [
      { path: "/admin/api/me", status: 200, data: { principal: "actor", scopeId: "org:fixture", isAdmin: true } },
      { path: "/admin/api/scopes", status: 200, data: { scopeId: "org:fixture", scopes: [] } },
      {
        path: "/api/sessions/mixed?tailTurns=25",
        status: 200,
        data: { session: { id: "mixed" }, entries: [user(200, "Initial legacy suffix")], earlierEntries: 200 },
      },
      {
        path: "/api/sessions/mixed?beforeSeq=200&tailTurns=25",
        status: 200,
        data: {
          session: { id: "mixed" },
          entries: [user(160, "Preparatory legacy page"), user(199, "Preparatory last entry")],
          earlierEntries: 160,
        },
      },
      {
        path: "/api/sessions/mixed?beforeSeq=160&tailTurns=25",
        status: 200,
        data: {
          session: { id: "mixed" },
          entries: [
            user(140, "Canonical boundary entry"),
            user(150, "Legacy boundary entry"),
            user(159, "Crossing last entry"),
          ],
          earlierEntries: 140,
        },
      },
    ],
  };
  const result = deriveViewFixtures(fixture, evidence);
  assert.equal(result.browser.mixedEarlierPage.preparePages.length, 1);
  assert.equal(result.browser.mixedEarlierPage.entrySeq, 140);
  assert.ok(result.browser.mixedEarlierPage.boundaryReady[0].root.includes('"150"'));
  const scenario = buildCatalog(result).find((row) => row.id === "web.chat.mixed-earlier");
  assert.deepEqual(scenario.missing, ["browser.sidebarReadiness"]);
  assert.equal(scenario.preparePages.length, 1);
  const bad = structuredClone(evidence);
  bad.rows.at(-1).data.entries = [user(140, "Canonical only, no crossing")];
  assert.equal(deriveViewFixtures(fixture, bad).browser.mixedEarlierPage, undefined);
});

test("readiness rejects shell-only, blank sentinel and missing fixture assertions", () => {
  assert.throws(() => validateReadySpec({ root: "body", texts: ["QM"] }));
  assert.throws(() => validateReadySpec({ root: "#view-data", texts: [] }));
  assert.throws(() => validateReadySpec({ root: ".custom-chat", texts: [""] }));
  assert.throws(() => validateReadySpec({ root: ".custom-chat", texts: ["SENTINEL"], missing: ["fixture"] }));
  assert.doesNotThrow(() => validateReadySpec({ root: ".custom-chat", texts: ["SENTINEL"], editable: "textarea" }));
  assert.doesNotThrow(() =>
    validateReadySpec({ root: "#view-governance", values: [{ selector: "#model", value: "fixture-model" }] }),
  );
});

test("secondary readiness waits for completed same-origin bodies and terminal catalog pages", () => {
  const requirement = [{ path: "/api/catalog", paginated: true }];
  const response = { path: "/api/catalog", method: "GET", status: 200 };
  assert.equal(requiredResponsesComplete([], requirement), false);
  assert.equal(requiredResponsesComplete([{ ...response, finalPage: true }], requirement), false);
  assert.equal(requiredResponsesComplete([{ ...response, completed: true }], requirement), false);
  assert.equal(
    requiredResponsesComplete([{ ...response, completed: true, finalPage: true, sameOrigin: false }], requirement),
    false,
  );
  assert.equal(requiredResponsesComplete([{ ...response, completed: true, finalPage: true }], requirement), true);
  assert.equal(
    requiredResponsesComplete([{ ...response, completed: true, finalPage: true }, response], requirement),
    false,
  );
  assert.equal(
    requiredResponsesComplete([{ ...response, completed: true, finalPage: true, status: 500 }], requirement),
    false,
  );
});

test("secondary readiness includes catalog refresh and conditional credential usage", () => {
  const requirements = secondaryRequests("admin.credentials", "org:fixture");
  const response = (path, extra = {}) => ({ path, method: "GET", status: 200, completed: true, ...extra });
  const primary = response("/admin/api/scopes/org%3Afixture", { settled: false, followupRequired: true });
  const rows = [primary, response("/admin/api/keychain")];
  assert.equal(requiredResponsesComplete(rows, requirements), false);
  primary.settled = true;
  assert.equal(requiredResponsesComplete(rows, requirements), false);
  rows.push(response("/admin/api/scopes/org%3Afixture/credential-usage"));
  assert.equal(requiredResponsesComplete(rows, requirements), true);
  primary.followupRequired = false;
  rows.pop();
  assert.equal(requiredResponsesComplete(rows, requirements), true);
  assert.ok(secondaryRequests("admin.memory", "org:fixture").some((entry) => entry.path === "/admin/api/scopes"));
});

test("disabled features require an explicit fixture contract, exact status/code and settled UI", () => {
  assert.equal(declaredDisabled({ enabled: false }), false);
  const disabled = { enabled: false, mode: "disabled", evidence: "isolated fixture credential inventory" };
  assert.equal(declaredDisabled(disabled), true);
  const cachedEmoji = secondaryRequests("admin.slack-settings", "org:fixture", {
    slack: { ...disabled, emojiCatalogAvailable: true },
  }).find((row) => row.path === "/admin/api/slack-emoji");
  assert.equal(cachedEmoji.expectedError, undefined);
  assert.equal(
    requiredResponsesComplete(
      [{ path: cachedEmoji.path, method: "GET", sameOrigin: true, completed: true, status: 200 }],
      [cachedEmoji],
    ),
    true,
  );
  const requirements = secondaryRequests("web.settings", "org:fixture", { composio: disabled });
  const responses = requirements.map((entry) => ({
    path: entry.path,
    sameOrigin: true,
    method: "GET",
    completed: true,
    status: entry.expectedStatuses?.[0] ?? 200,
    expectedErrorMatched: true,
  }));
  assert.equal(requiredResponsesComplete(responses, requirements), true);
  responses[1].expectedErrorMatched = false;
  assert.equal(requiredResponsesComplete(responses, requirements), false);
  responses[1].expectedErrorMatched = true;
  responses[1].status = 502;
  assert.equal(requiredResponsesComplete(responses, requirements), false);
  const catalog = buildCatalog({
    browser: { features: { composio: disabled } },
    views: { "web.settings": { expectedText: "fixture-user" } },
  });
  assert.ok(
    catalog
      .find((entry) => entry.id === "web.settings")
      .ready.texts.some((entry) => entry.includes("App connections aren’t available")),
  );
  for (const feature of ["composio", "loops", "inbox"]) {
    const reasons = validateQualification(
      run,
      { browser: { features: { [feature]: disabled } } },
      { checks: [{ name: "feature-configuration", expected: { [feature]: true }, observed: { [feature]: false } }] },
    );
    assert.ok(reasons.includes(`Fixture feature configuration differs from production: ${feature}`));
  }
});

test("view derivation preserves absent fixtures as gaps instead of accepting empty headings", () => {
  const fixture = {
    fixtureId: "fixture",
    orgScopeId: "org:fixture",
    adminPrincipalId: "actor",
    cohorts: { max: { scopeId: "personal:actor" } },
    views: { deployments: { expectedText: "Apps" } },
  };
  const evidence = {
    fixtureId: "fixture",
    rows: [
      { path: "/admin/api/me", status: 200, data: { principal: "actor", scopeId: "org:fixture", isAdmin: true } },
      { path: "/admin/api/scopes", status: 200, data: { scopeId: "org:fixture", scopes: [] } },
      { path: "/admin/api/deployments?scope=org%3Afixture", status: 200, data: { deployments: [] } },
      { path: "/admin/api/slack-mirror", status: 200, data: { containers: [] } },
    ],
  };
  const derived = deriveViewFixtures(fixture, evidence);
  assert.equal(derived.views.deployments, undefined);
  assert.ok(derived.viewReadinessEvidence.missing.some((entry) => entry.id === "admin.slack"));
  assert.throws(() => deriveViewFixtures(fixture, { ...evidence, fixtureId: "another" }));
});

test("admin history uses independent scope cohorts and derives seeded search and Slack evidence", () => {
  const fixture = {
    fixtureId: "fixture",
    orgScopeId: "org:fixture",
    adminPrincipalId: "actor",
    cases: { short: { principalId: "actor" } },
    cohorts: { max: { scopeId: "personal:web-actor" } },
    adminHistoryCohorts: {
      max: { scopeId: "channel:admin-history", conversationCount: 61, rootCase: { sessionId: "first" } },
    },
  };
  const path = "/admin/api/sessions?scope=channel%3Aadmin-history&limit=50&offset=";
  const evidence = {
    fixtureId: "fixture",
    rows: [
      { path: "/admin/api/me", status: 200, data: { principal: "actor", scopeId: "org:fixture", isAdmin: true } },
      {
        path: "/admin/api/scopes",
        status: 200,
        data: {
          scopeId: "org:fixture",
          scopes: [{ scopeId: "channel:admin-history", label: "Fixture history", sessions: 61 }],
        },
      },
      {
        path: `${path}0&category=conversation`,
        status: 200,
        data: {
          scopeId: "channel:admin-history",
          offset: 0,
          limit: 50,
          total: 61,
          sessions: Array.from({ length: 50 }, (_, i) => ({
            id: i ? `first-${i}` : "first",
            scopeId: "channel:admin-history",
            firstMessage: i ? `QM performance fixture first page ${i}` : "QM PERF first first",
          })),
        },
      },
      {
        path: `${path}50&category=conversation`,
        status: 200,
        data: {
          scopeId: "channel:admin-history",
          offset: 50,
          limit: 50,
          total: 61,
          sessions: Array.from({ length: 11 }, (_, i) => ({
            id: i ? `later-${i}` : "later",
            scopeId: "channel:admin-history",
            firstMessage: i ? `QM performance fixture later page ${i}` : "QM PERF later first",
          })),
        },
      },
      {
        path: "/admin/api/slack-mirror",
        status: 200,
        data: {
          containers: [{ container: "perf-channel", name: "performance-channel", kind: "channel", messageCount: 3 }],
        },
      },
      {
        path: "/api/search?q=performance",
        status: 200,
        data: { hits: [{ sessionId: "first", surface: "web", snippet: "Measured performance fixture chat" }] },
      },
      {
        path: "/api/resources/search?q=performance",
        status: 200,
        data: { hits: [{ title: "fixture-skill", snippet: "QM performance skill" }] },
      },
    ],
  };
  const derived = deriveViewFixtures(fixture, evidence);
  const catalog = buildCatalog(derived);
  assert.equal(
    catalog.find((entry) => entry.id === "admin.history.max").path,
    "/admin/history/scopes/channel%3Aadmin-history",
  );
  assert.equal(
    catalog.find((entry) => entry.id === "admin.history.next").path,
    "/admin/history/scopes/channel%3Aadmin-history",
  );
  assert.deepEqual(derived.views["history.next"].expectedText, ["QM PERF later first"]);
  assert.deepEqual(derived.views.slack.expectedText, ["#performance-channel"]);
  assert.deepEqual(derived.views["web.search"].expectedText, [
    "Measured performance fixture chat",
    "fixture-skill",
    "QM performance skill",
  ]);
  const wrongCount = structuredClone(evidence);
  wrongCount.rows.find((row) => row.path === `${path}0&category=conversation`).data.total = 1;
  assert.equal(deriveViewFixtures(fixture, wrongCount).views["history.max"], undefined);
  const partial = structuredClone(evidence);
  partial.rows.find((row) => row.path === "/api/resources/search?q=performance").data.failed = ["files"];
  assert.equal(deriveViewFixtures(fixture, partial).views["web.search"], undefined);
  const reorderedFixture = structuredClone(fixture);
  reorderedFixture.adminHistoryCohorts.max.rootCase.sessionId = "not-on-first-page";
  const reordered = structuredClone(evidence);
  const firstPage = reordered.rows.find((row) => row.path === `${path}0&category=conversation`).data;
  firstPage.sessions[0].firstMessage = "QM performance fixture actual first-page row";
  const normalized = deriveViewFixtures(reorderedFixture, reordered);
  assert.deepEqual(normalized.views["history.max"].expectedText, ["QM performance fixture actual first-page row"]);
  assert.ok(
    normalized.viewReadinessEvidence.normalizations.some(
      (row) =>
        row.view === "history.max" &&
        row.declaredSessionId === "not-on-first-page" &&
        row.renderedSessionId === "first" &&
        row.offset === 0,
    ),
  );
  for (const change of [
    (page) => {
      page.offset = 1;
    },
    (page) => {
      page.limit = 100;
    },
    (page) => {
      page.sessions.pop();
    },
    (page) => {
      page.sessions[0].scopeId = "channel:other";
    },
    (page) => {
      page.sessions[0].firstMessage = "not a synthetic fixture sentinel";
    },
  ]) {
    const invalid = structuredClone(evidence);
    change(invalid.rows.find((row) => row.path === `${path}0&category=conversation`).data);
    assert.equal(deriveViewFixtures(fixture, invalid).views["history.max"], undefined);
  }
});

test("web view evidence belongs to its actual actor and never falls back to admin", () => {
  const fixture = {
    fixtureId: "distinct-actors",
    adminPrincipalId: "admin",
    orgScopeId: "org:test",
    cases: { short: { principalId: "web" } },
  };
  const rows = [
    {
      path: "/admin/api/me",
      principalId: "admin",
      status: 200,
      data: { principal: "admin", scopeId: "org:test", isAdmin: true },
    },
    { path: "/admin/api/scopes", principalId: "admin", status: 200, data: { scopeId: "org:test", scopes: [] } },
  ];
  for (const principalId of ["admin", "web"]) {
    for (const [path, data] of [
      [
        "/me",
        {
          user: principalId,
          displayName: principalId,
          org: "test",
          permissions: principalId === "admin" ? ["admin", "loops"] : [],
        },
      ],
      ["/api/user-model-auth/status", { account: "company" }],
      ["/api/search?q=performance", { hits: [{ surface: "web", snippet: `${principalId} conversation` }] }],
      [
        "/api/resources/search?q=performance",
        { hits: [{ title: `${principalId} skill`, snippet: `QM performance ${principalId}` }] },
      ],
    ])
      rows.push({ path, principalId, status: 200, data });
  }
  const derive = (rows) => deriveViewFixtures(fixture, { fixtureId: fixture.fixtureId, rows });
  const result = derive(rows);
  assert.deepEqual(result.views["web.settings"]?.expectedText, ["web · test"]);
  assert.ok(!result.views["web.browse"].expectedText.includes("Admin"));
  assert.ok(!result.views["web.browse"].expectedText.includes("Loops"));
  assert.deepEqual(result.views["web.search"].expectedText, ["web conversation", "web skill", "QM performance web"]);
  const missing = derive(rows.filter((row) => row.principalId !== "web"));
  for (const view of ["web.settings", "web.browse", "web.search"]) assert.equal(missing.views[view], undefined);
});

test("multiview fixture represents twelve tabs across four visible panes", () => {
  const state = multiviewState(
    Array.from({ length: 12 }, (_, i) => ({ sessionId: `session-${i}`, principalId: "actor" })),
    123,
  );
  assert.equal(Object.keys(state.layout.panels).length, 12);
  assert.equal(state.layout.grid.root.data.length, 4);
  assert.deepEqual(
    state.layout.grid.root.data.map((leaf) => leaf.data.activeView),
    ["perf-pane-2", "perf-pane-5", "perf-pane-8", "perf-pane-11"],
  );
});

test("configuration cannot attach to a user profile or silently omit budgets", () => {
  const config = {
    baseUrl: "http://localhost:8000",
    isolated: true,
    mode: "diagnostic",
    samples: 3,
    loadCondition: "normal",
    sourceRevision: "a".repeat(40),
    browser: {
      viewport: { width: 1440, height: 1000 },
      cpuThrottleRate: 1,
      network: { latencyMs: 20, downloadBytesPerSecond: 1000000, uploadBytesPerSecond: 1000000 },
    },
  };
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(() => validateConfig({ ...config, userDataDir: "/user/profile" }));
  assert.throws(() => validateConfig({ ...config, baseUrl: "http://localhost:8000/private" }));
  assert.throws(() => validateConfig({ ...config, mode: "qualifying" }));
  assert.throws(() => validateConfig({ ...config, isolated: false }));
  assert.doesNotThrow(() => validateConfig({ ...config, cacheFilter: "cold" }));
  assert.throws(() => validateConfig({ ...config, mode: "qualifying", samples: 31, cacheFilter: "cold" }));
});

test("a single fast candidate run is not a qualified campaign", () => {
  const result = verifyCampaign({ baseline: [], candidate: [{ run, samples: observations(), fixture: {} }] });
  assert.equal(result.qualified, false);
  assert.ok(result.reasons.some((reason) => reason.includes("two independent candidate runs")));
  assert.ok(result.reasons.some((reason) => reason.includes("Missing baseline")));
});

test("loaded disabled cards and duplicate row text cannot conceal pending or incorrect content", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120);
    await page.setContent(
      '<main id="fixture"><a href="/first">Repeated fixture preview</a><div class="welcome-load"><p role="status">Disabled by fixture</p></div></main>',
    );
    const ready = { root: "#fixture", texts: ["Repeated fixture preview"], absentSelectors: ['a[href="/next"]'] };
    await waitReady(page, ready);
    await page.locator(".welcome-load").evaluate((element) => element.setAttribute("role", "status"));
    await assert.rejects(waitReady(page, ready), /Timeout/);
    await page.locator(".welcome-load").evaluate((element) => element.removeAttribute("role"));
    await page.locator("#fixture").evaluate((element) => {
      const warning = globalThis.document.createElement("div");
      warning.className = "chat-search-failed";
      warning.textContent = "Could not search files";
      element.append(warning);
    });
    await assert.rejects(waitReady(page, ready), /Timeout/);
    await page.locator(".chat-search-failed").evaluate((element) => element.remove());
    await page.locator("a").evaluate((element) => element.setAttribute("href", "/next"));
    await assert.rejects(waitReady(page, ready), /Timeout/);
  } finally {
    await browser.close();
  }
});

test("fixture preparation derives first-page sidebar identities and the actual preceding bounded transcript", () => {
  const fixture = {
    fixtureId: "fixture",
    orgScopeId: "org:fixture",
    adminPrincipalId: "actor",
    cohorts: { max: { principalId: "actor", rootCase: { sessionId: "late" } } },
    cases: {
      long: {
        sessionId: "long",
        principalId: "actor",
        expectedVisibleText: "LAST",
        earlierVisibleText: "OLD NOMINAL BOUNDARY",
      },
    },
  };
  const sessions = Array.from({ length: 60 }, (_, i) => ({
    id: i === 59 ? "late" : `session-${i}`,
    threadRef: `web:session-${i}`,
    surface: "web",
    createdAt: 100 - i,
  }));
  const evidence = {
    fixtureId: "fixture",
    rows: [
      { path: "/admin/api/me", status: 200, data: { principal: "actor", scopeId: "org:fixture", isAdmin: true } },
      { path: "/admin/api/scopes", status: 200, data: { scopeId: "org:fixture", scopes: [] } },
      { path: "/me", principalId: "actor", status: 200, data: { user: "actor" } },
      { path: "/api/sessions", principalId: "actor", status: 200, data: { sessions } },
      {
        path: "/api/sessions/long?tailTurns=25",
        status: 200,
        data: { session: { id: "long" }, entries: [{ seq: 100, type: "user" }], earlierEntries: 100 },
      },
      {
        path: "/api/sessions/long?beforeSeq=100&tailTurns=25",
        status: 200,
        data: {
          session: { id: "long" },
          entries: [
            { seq: 90, type: "user", payload: { text: "Previously bounded fixture message" } },
            { seq: 99, type: "assistant" },
          ],
          earlierEntries: 90,
        },
      },
      {
        path: "/admin/api/audit?scope=org%3Afixture",
        status: 200,
        data: { scopeId: "org:fixture", events: [{ principalId: "actor", action: "audit.read", resource: "audit" }] },
      },
    ],
  };
  const derived = deriveViewFixtures(fixture, evidence);
  assert.equal(derived.browser.rootSidebarCases.max.sessionId, "session-0");
  assert.equal(derived.browser.earlierPage.entrySeq, 90);
  assert.equal(derived.browser.earlierPage.expectedVisibleText, "Previously bounded fixture message");
  assert.equal(derived.browser.earlierPage.initialFirstSeq, 100);
  assert.deepEqual(derived.views.audit.rowTexts, [{ selector: "tbody tr", texts: ["actor", "audit.read", "audit"] }]);
  const catalog = buildCatalog(derived);
  assert.equal(
    catalog.find((row) => row.id === "web.chat.earlier").ready[1].root,
    '.custom-chat [data-entry-seqs~="90"]',
  );
  assert.ok(catalog.find((row) => row.id === "web.root.max").ready.visible.includes("session-0"));
  const bad = structuredClone(evidence);
  bad.rows.find((row) => row.path.includes("beforeSeq")).data.entries[0].seq = 101;
  assert.equal(deriveViewFixtures(fixture, bad).browser.earlierPage, undefined);
});

test("sidebar pagination uses native thread surfaces and clears rejected cloned anchors", () => {
  const fixture = {
    fixtureId: "fixture",
    orgScopeId: "org:fixture",
    adminPrincipalId: "actor",
    cohorts: { max: { principalId: "actor", rootCase: { sessionId: "web-0" } } },
    sidebarPagination: { principalId: "actor", sessionId: "web-0" },
    browser: { sidebarPagination: { principalId: "actor", sessionId: "web-52" } },
  };
  const sessions = Array.from({ length: 110 }, (_, i) => ({
    id: `web-${i}`,
    threadRef: `web:actor:${i}`,
    surface: i % 5 ? "web" : "slack",
    scopeId: i % 2 ? "personal:actor" : "project:fixture",
    createdAt: 200 - i,
  }));
  sessions[49].threadRef = "agent:main:subagent:visible";
  sessions[49].surface = "web";
  sessions.unshift(
    { id: "wrong-surface", threadRef: "dm:actor:slack", surface: "web", createdAt: 999 },
    { id: "pinned", threadRef: "web:actor:pinned", surface: "web", pinned: true, createdAt: 999 },
    { id: "archived", threadRef: "web:actor:archived", surface: "web", archived: true, createdAt: 999 },
    { id: "child", threadRef: "web:actor:child", surface: "web", parentSessionId: "web-0", createdAt: 999 },
  );
  const evidence = {
    fixtureId: "fixture",
    rows: [
      { path: "/admin/api/me", status: 200, data: { principal: "actor", scopeId: "org:fixture", isAdmin: true } },
      { path: "/admin/api/scopes", status: 200, data: { scopeId: "org:fixture", scopes: [] } },
      { path: "/me", status: 200, data: { user: "actor" } },
      { path: "/api/sessions", status: 200, data: { sessions } },
    ],
  };
  const derived = deriveViewFixtures(fixture, evidence);
  assert.equal(derived.browser.rootSidebarCases.max.sessionId, "web-0");
  assert.equal(derived.sidebarPagination.sessionId, "web-52");
  assert.equal(derived.browser.sidebarPagination, undefined);
  assert.equal(fixture.browser.sidebarPagination.sessionId, "web-52");
  for (const sessionId of ["web-0", "web-109", "missing", "wrong-surface"]) {
    const input = structuredClone(fixture);
    input.browser.sidebarPagination.sessionId = sessionId;
    const normalized = deriveViewFixtures(input, evidence);
    assert.equal(normalized.sidebarPagination.sessionId, "web-50");
    assert.ok(
      normalized.viewReadinessEvidence.normalizations.some(
        (row) => row.view === "sidebarPagination" && row.declaredSessionId === sessionId && row.renderedOrdinal === 50,
      ),
    );
  }
  const short = structuredClone(evidence);
  short.rows.find((row) => row.path === "/api/sessions").data.sessions = sessions.slice(0, 54);
  const unsupported = deriveViewFixtures(fixture, short);
  assert.equal(unsupported.sidebarPagination, undefined);
  assert.equal(unsupported.browser.sidebarPagination, undefined);
  assert.ok(unsupported.viewReadinessEvidence.gaps.some((row) => row.scenario === "sidebarPagination"));
  assert.ok(buildCatalog(unsupported).find((row) => row.id === "web.sidebar.more").missing.length);
});

test("UI setup writes and verifies only the authenticated fixture principal through the real API contract", async () => {
  let state = { value: { active: true }, updatedAt: Date.now() + 1000 };
  let writes = 0;
  const response = (data) => ({ ok: () => true, json: async () => structuredClone(data) });
  const request = {
    get: async (url) => response(new URL(url).pathname === "/me" ? { user: "actor" } : state),
    put: async (url, options) => {
      assert.equal(url, "http://localhost:8129/api/ui-state");
      assert.equal(options.headers.origin, "http://localhost:8129");
      assert.equal(options.data.key, "split-canvas");
      assert.ok(options.data.updatedAt > state.updatedAt);
      state = { value: options.data.value, updatedAt: options.data.updatedAt };
      writes++;
      return response({ ok: true, updatedAt: state.updatedAt });
    },
  };
  const settled = await establishSplitState(request, "http://localhost:8129", "actor", { v: 2, active: false });
  assert.deepEqual(settled, state.value);
  assert.equal(settled.active, false);
  await assert.rejects(
    establishSplitState(request, "http://localhost:8129", "another", { v: 2, active: true }),
    /another principal/,
  );
  assert.equal(writes, 1);
});

function sidebarOracleFixture() {
  const people = ["actor-a", "actor-b", "actor-c", "actor-extra"];
  const sessions = Object.fromEntries(
    people.map((actor) => [
      actor,
      [
        ...Array.from({ length: 112 }, (_, i) => ({
          id: `${actor}-${String(i).padStart(3, "0")}`,
          threadRef: `web:${actor}:${i}`,
          scopeId: i < 60 ? `group:${actor}-${i}` : `personal:${actor}`,
          type: "dm",
          title: `Conversation ${actor} ${i}`,
          createdAt: i + 1,
          lastActivityAt: 1000 - i,
        })),
        ...Array.from({ length: 55 }, (_, i) => ({
          id: `${actor}-pin-${i}`,
          threadRef: `web:${actor}:pin-${i}`,
          scopeId: `personal:${actor}`,
          type: "dm",
          title: `Pin ${i}`,
          createdAt: 1,
          lastActivityAt: 2000 - i,
          pinned: true,
        })),
        {
          id: `${actor}-archive`,
          threadRef: `web:${actor}:archive`,
          scopeId: `personal:${actor}`,
          type: "dm",
          createdAt: 1,
          archived: true,
        },
        {
          id: `${actor}-child`,
          threadRef: `web:${actor}:child`,
          scopeId: `personal:${actor}`,
          type: "dm",
          createdAt: 9999,
          parentSessionId: `${actor}-000`,
        },
        {
          id: `${actor}-slack`,
          threadRef: `dm:${actor}:slack`,
          scopeId: `personal:${actor}`,
          type: "dm",
          createdAt: 9999,
        },
      ],
    ]),
  );
  const contexts = Object.fromEntries(
    people.map((actor) => [
      actor,
      [
        { scopeId: `personal:${actor}`, kind: "personal", name: null, lastActivityAt: 9999 },
        ...Array.from({ length: 60 }, (_, i) => ({
          scopeId: `group:${actor}-${i}`,
          kind: "group",
          name: `Group ${i}`,
          lastActivityAt: 9999,
        })),
      ],
    ]),
  );
  const item = (actor, suffix = "000") => ({
    principalId: actor,
    sessionId: `${actor}-${suffix}`,
    expectedVisibleText: `Sentinel ${actor}`,
  });
  const fixture = {
    fixtureId: "sidebar-oracle",
    adminPrincipalId: "actor-a",
    orgScopeId: "org:fixture",
    cohorts: Object.fromEntries(
      ["median", "p95", "max"].map((name, i) => [name, { principalId: people[i], rootCase: item(people[i]) }]),
    ),
    cases: {
      short: item("actor-a"),
      long: item("actor-a", "109"),
      dense: item("actor-b"),
      slack: item("actor-a", "slack"),
      legacy: item("actor-a", "101"),
      mixed: item("actor-a", "102"),
    },
    multiview: Array.from({ length: 12 }, (_, i) => item("actor-extra", String(i + 90).padStart(3, "0"))),
    sidebarPagination: item("actor-a", "050"),
  };
  const observations = {
    fixtureId: fixture.fixtureId,
    rows: people.flatMap((principalId) => [
      { path: "/me", principalId, status: 200, data: { user: principalId } },
      { path: "/api/sessions", principalId, status: 200, data: { sessions: sessions[principalId] } },
      { path: "/api/contexts", principalId, status: 200, data: { contexts: contexts[principalId] } },
    ]),
  };
  return { fixture, observations, sessions, contexts };
}
const sidebarProfile = (transport) => ({ transport, sourceRevision: "a".repeat(40) });

test("one campaign fixture selects exact source expectations without changing dataset bytes or catalog coverage", () => {
  const { fixture, observations, sessions } = sidebarOracleFixture();
  fixture.browser = { visibleGroups: 4, maxPanels: 12, features: { loops: { enabled: true } } };
  observations.rows.find((row) => row.path === "/me" && row.principalId === "actor-a").data.permissions = [];
  const recent = sessions["actor-a"].splice(0, 112).reverse();
  recent.forEach((row) => (row.lastActivityAt = 1000));
  sessions["actor-a"].unshift(...recent);
  fixture.sidebarPagination.sessionId = "actor-a-000";
  observations.rows.push(
    {
      path: "/admin/api/me",
      principalId: "actor-a",
      status: 200,
      data: { principal: "actor-a", scopeId: fixture.orgScopeId, isAdmin: true },
    },
    {
      path: "/admin/api/scopes",
      principalId: "actor-a",
      status: 200,
      data: { scopeId: fixture.orgScopeId, scopes: [] },
    },
  );
  const profiles = [sidebarProfile("legacy-get"), { transport: "navigation-post", sourceRevision: "b".repeat(40) }];
  const original = JSON.stringify(fixture);
  const common = deriveViewFixtures(fixture, observations, { sidebarProfiles: profiles });
  const bytes = JSON.stringify(common);
  assert.equal(common.viewReadinessBySource.length, 2);
  assert.equal(common.browser.features.loops.enabled, false);
  assert.equal(fixture.browser.features.loops.enabled, true);
  const catalogs = profiles.map((profile) => buildCatalog(common, profile.sourceRevision));
  for (const [index, profile] of profiles.entries()) {
    const single = deriveViewFixtures(fixture, observations, { sidebarProfile: profile });
    assert.deepEqual(catalogs[index], buildCatalog(single));
    assert.equal(catalogs[index].length, 60);
    assert.equal(cellsFor(catalogs[index], "normal").length, 109);
    assert.ok(
      catalogs[index]
        .filter((row) => !row.admin)
        .every((row) => row.sidebarReadiness.sourceRevision === profile.sourceRevision),
    );
    assert.deepEqual(deriveSidebarReadiness(common, observations, profile), single.browser.sidebarReadiness);
    const recorded = {
      ...run,
      sourceRevision: profile.sourceRevision,
      sidebarProfile: profile,
      catalog: catalogs[index],
    };
    const sourceReasons = (value) =>
      validateQualification(value, common).filter(
        (reason) =>
          reason.startsWith("Prepared source") && reason !== "Prepared source catalog is missing readiness data",
      );
    assert.deepEqual(sourceReasons(recorded), []);
    assert.ok(validateQualification(recorded, common).includes("Prepared source catalog is missing readiness data"));
    const omitted = structuredClone(common);
    delete omitted.viewReadinessBySource;
    assert.ok(validateQualification(recorded, omitted).includes("Prepared source pair is required for qualification"));
    for (const wrong of [
      { ...recorded, sourceRevision: "c".repeat(40) },
      { ...recorded, sidebarProfile: profiles[1 - index] },
      { ...recorded, catalog: catalogs[1 - index] },
    ])
      assert.ok(sourceReasons(wrong).length);
  }
  assert.notEqual(
    catalogs[0].find((row) => row.id === "web.root.median").ready.visible,
    catalogs[1].find((row) => row.id === "web.root.median").ready.visible,
  );
  assert.notEqual(
    catalogs[0].find((row) => row.id === "web.sidebar.more").ready.visible,
    catalogs[1].find((row) => row.id === "web.sidebar.more").ready.visible,
  );
  assert.equal(JSON.stringify(fixture), original);
  assert.equal(JSON.stringify(common), bytes);
  assert.deepEqual(deriveViewFixtures(common, observations, { sidebarProfiles: profiles }), common);
  for (const field of ["visibleGroups", "maxPanels", "features", "multiview", "adminPrincipalId"]) {
    const changed = structuredClone(common);
    changed.viewReadinessBySource[1].browser[field] = field === "features" ? { loops: { enabled: true } } : 2;
    assert.throws(() => buildCatalog(changed, profiles[1].sourceRevision));
  }
  for (const view of ["web.search", "web.browse"]) {
    const changed = structuredClone(common);
    changed.viewReadinessBySource[1].views[view] = { query: "different workload" };
    for (const profile of profiles) assert.throws(() => buildCatalog(changed, profile.sourceRevision));
  }
  const changedActor = structuredClone(common);
  changedActor.viewReadinessBySource[1].sidebarPagination.principalId = "actor-b";
  for (const profile of profiles) assert.throws(() => buildCatalog(changedActor, profile.sourceRevision));
  for (const revision of [undefined, "HEAD", "c".repeat(40)]) assert.throws(() => buildCatalog(common, revision));
  const duplicate = structuredClone(common);
  duplicate.viewReadinessBySource.push(duplicate.viewReadinessBySource[0]);
  assert.throws(() => buildCatalog(duplicate, profiles[0].sourceRevision));
  const stale = structuredClone(common);
  stale.viewReadinessBySource[1].browser.sidebarReadiness.sourceRevision = profiles[0].sourceRevision;
  assert.throws(() => buildCatalog(stale, profiles[1].sourceRevision));
  const partial = deriveViewFixtures(
    common,
    { ...observations, rows: observations.rows.filter((row) => row.principalId !== "actor-extra") },
    { sidebarProfiles: profiles },
  );
  for (const profile of profiles)
    assert.ok(
      buildCatalog(partial, profile.sourceRevision)
        .filter((row) => !row.admin)
        .every((row) => row.missing.includes("browser.sidebarReadiness")),
    );
  for (const sidebarProfiles of [
    [],
    [profiles[0]],
    [profiles[0], profiles[0]],
    [{ ...profiles[0], sourceRevision: "HEAD" }, profiles[1]],
  ])
    assert.throws(() => deriveViewFixtures(fixture, observations, { sidebarProfiles }));
});

test("sidebar oracle derives all actors, full recent prefixes, profile-specific groups/pins and exact continuations", () => {
  const { fixture, observations } = sidebarOracleFixture();
  for (const transport of ["legacy-get", "navigation-post"]) {
    const output = deriveSidebarReadiness(fixture, observations, sidebarProfile(transport));
    assert.deepEqual(Object.keys(output.actors), ["actor-a", "actor-b", "actor-c", "actor-extra"]);
    const actor = output.actors["actor-a"];
    assert.equal(actor.recent.total, 112);
    for (const [rows, start] of [
      [actor.recent.firstRows, 0],
      [actor.recent.secondRows, 50],
    ])
      assert.deepEqual(
        rows.map((r) => r.id),
        Array.from({ length: 50 }, (_, i) => `actor-a-${String(i + start).padStart(3, "0")}`),
      );
    assert.equal(actor.recent.allRows.at(-1).title, "Conversation actor-a 111");
    assert.equal(actor.recent.firstHasMore, true);
    assert.equal(actor.recent.secondHasMore, true);
    assert.equal(actor.pinned.total, 55);
    assert.equal(actor.pinned.rows.length, transport === "legacy-get" ? 55 : 50);
    assert.equal(actor.pinned.hasMore, transport === "navigation-post");
    assert.equal(actor.groups.total, 61);
    assert.equal(actor.groups.items.length, transport === "legacy-get" ? 61 : 50);
    assert.equal(actor.groups.firstItems.length, 50);
    assert.equal(actor.groups.secondItems.length, transport === "legacy-get" ? 61 : 50);
    assert.equal(actor.groups.items[0].lastActivityAtAtPreparation, 1000);
    assert.deepEqual(actor.groups.dynamicOrderScopes, []);
    assert.equal(actor.archivedCount, 1);
    assert.equal(actor.startup.hasNonCronSessions, true);
    assert.ok(actor.allowedOffPageRows.some((row) => row.id === "actor-a-109"));
    assert.equal(output.actors["actor-extra"].allowedOffPageRows.length, 12);
    for (const row of Object.values(actor.evidence)) assert.match(row.sha256, /^[a-f0-9]{64}$/);
    const catalog = buildCatalog({ ...fixture, browser: { sidebarReadiness: output } });
    assert.equal(catalog.length, 60);
    assert.equal(cellsFor(catalog, "normal").length, 109);
    for (const row of catalog.filter((row) => !row.admin)) {
      assert.equal(row.sidebarReadiness.transport, transport);
      assert.equal(row.sidebarReadiness.actors, undefined);
    }
    assert.ok(
      catalog
        .find((row) => row.id === "web.chat.slack")
        .missing.includes("browser.sidebarReadiness: dynamic all-surface oracle unresolved"),
    );
    assert.ok(catalog.filter((row) => row.admin).every((row) => row.sidebarReadiness === undefined));
  }
});

test("sidebar oracle preserves legacy stable ties and explicit candidate identity ties with DOM title rules", () => {
  const { fixture, observations, sessions, contexts } = sidebarOracleFixture();
  const rows = sessions["actor-a"];
  [rows[0], rows[1]] = [rows[1], rows[0]];
  rows[0].lastActivityAt = rows[1].lastActivityAt = 1000;
  rows[0].title = null;
  rows[0].type = "group";
  rows[0].channelName = "mpdm-alice-smith--bob-jones-1";
  rows[112].title = null;
  rows[112].type = "group";
  rows[112].channelName = "Alice, Bob";
  contexts["actor-a"].find((row) => row.scopeId === "group:actor-a-1").name = "mpdm-alice-smith--bob-jones-1";
  const baseline = deriveSidebarReadiness(fixture, observations, sidebarProfile("legacy-get")).actors["actor-a"];
  const candidate = deriveSidebarReadiness(fixture, observations, sidebarProfile("navigation-post")).actors["actor-a"];
  assert.deepEqual(
    baseline.recent.firstRows.slice(0, 2).map((row) => row.id),
    ["actor-a-001", "actor-a-000"],
  );
  assert.deepEqual(
    candidate.recent.firstRows.slice(0, 2).map((row) => row.id),
    ["actor-a-000", "actor-a-001"],
  );
  assert.equal(baseline.recent.firstRows[0].title, "2 alice smith, bob jones");
  assert.equal(baseline.recent.firstRows[0].groupedTitle, "Web chat");
  assert.equal(baseline.pinned.rows[0].title, "2 Alice, Bob");
  assert.equal(candidate.recent.firstRows[1].title, "2 alice smith, bob jones");
  assert.equal(candidate.pinned.rows[0].title, "2 Alice, Bob");
  assert.equal(baseline.groups.items[0].name, "alice smith, bob jones");
  assert.equal(candidate.groups.items[0].scopeId, "group:actor-a-0");
  rows[112].channelName = "Alice\u00a0Smith, Bob";
  for (const transport of ["legacy-get", "navigation-post"]) {
    const actor = deriveSidebarReadiness(fixture, observations, sidebarProfile(transport)).actors["actor-a"];
    assert.equal(actor.pinned.rows[0].title, "2 Alice\u00a0Smith, Bob");
    assert.notEqual(actor.pinned.rows[0].title, "2 Alice Smith, Bob");
  }
});

test("sidebar oracle rejects ambiguous/foreign evidence, missing actors and undeclared transport", () => {
  const { fixture, observations } = sidebarOracleFixture();
  for (const profile of [
    undefined,
    { transport: "auto", sourceRevision: "a".repeat(40) },
    { ...sidebarProfile("navigation-post"), fallback: true },
    { transport: "legacy-get", sourceRevision: "HEAD" },
  ])
    assert.throws(() => deriveSidebarReadiness(fixture, observations, profile));
  for (const mutate of [
    (value) => value.rows.pop(),
    (value) => value.rows.push(value.rows[0]),
    (value) => {
      value.rows[0].data.user = "foreign";
    },
    (value) => {
      value.rows[1].status = 403;
    },
    (value) => {
      value.rows[1].data.sessions.push(value.rows[1].data.sessions[0]);
    },
    (value) => {
      value.rows[1].data.sessions.find((row) => row.id === "actor-a-109").id = "another";
    },
    (value) => {
      value.rows[2].data.contexts[0].lastActivityAt = "now";
    },
  ]) {
    const copy = structuredClone(observations);
    mutate(copy);
    assert.throws(() => deriveSidebarReadiness(fixture, copy, sidebarProfile("navigation-post")));
  }
});

test("empty personal/project ordering is unresolved and empty channel/group contexts are omitted", () => {
  const { fixture, observations, contexts } = sidebarOracleFixture();
  contexts["actor-a"].unshift(
    {
      scopeId: "group:empty-project",
      kind: "group",
      name: "unused",
      project: { name: "Empty project", createdAt: 1, updatedAt: 2 },
      lastActivityAt: 99999,
    },
    { scopeId: "channel:empty", kind: "channel", name: "empty", lastActivityAt: 999999 },
    { scopeId: "group:empty", kind: "group", name: "empty", lastActivityAt: 999999 },
  );
  for (const transport of ["legacy-get", "navigation-post"]) {
    const output = deriveSidebarReadiness(fixture, observations, sidebarProfile(transport));
    const groups = output.actors["actor-a"].groups;
    assert.equal(groups.items[0].scopeId, "group:empty-project");
    assert.equal(groups.firstItems[0].count, 0);
    assert.deepEqual(groups.dynamicOrderScopes, ["group:empty-project"]);
    assert.ok(!groups.items.some((row) => row.scopeId === "channel:empty" || row.scopeId === "group:empty"));
    const catalog = buildCatalog({ ...fixture, browser: { sidebarReadiness: output } });
    assert.ok(
      catalog
        .find((row) => row.id === "web.chat.short")
        .missing.includes("browser.sidebarReadiness.dynamicOrderScopes"),
    );
  }
});

test("view derivation binds the explicit profile and never reuses a cloned or partially observed sidebar oracle", () => {
  const { fixture, observations } = sidebarOracleFixture();
  observations.rows.push(
    {
      path: "/admin/api/me",
      principalId: "actor-a",
      status: 200,
      data: { principal: "actor-a", scopeId: fixture.orgScopeId, isAdmin: true },
    },
    {
      path: "/admin/api/scopes",
      principalId: "actor-a",
      status: 200,
      data: { scopeId: fixture.orgScopeId, scopes: [] },
    },
  );
  const options = { sidebarProfile: sidebarProfile("navigation-post") };
  const derived = deriveViewFixtures(fixture, observations, options);
  assert.equal(derived.browser.sidebarReadiness.sourceRevision, options.sidebarProfile.sourceRevision);
  assert.equal(derived.sidebarPagination.sessionId, "actor-a-050");
  assert.deepEqual(derived.browser.sidebarReadiness.actors["actor-a"].recent.firstRows[0], {
    id: "actor-a-000",
    title: "Conversation actor-a 0",
    groupedTitle: "Conversation actor-a 0",
    scopeId: "group:actor-a-0",
  });
  for (const [evidence, profile] of [
    [observations, undefined],
    [
      { ...observations, rows: observations.rows.filter((row) => row.principalId !== "actor-extra") },
      options.sidebarProfile,
    ],
  ]) {
    const rejected = deriveViewFixtures(derived, evidence, { sidebarProfile: profile });
    assert.equal(rejected.browser.sidebarReadiness, undefined);
    assert.ok(rejected.viewReadinessEvidence.gaps.some((row) => row.scenario === "web.sidebarReadiness"));
    assert.ok(
      buildCatalog(rejected)
        .filter((row) => !row.admin)
        .every((row) => row.missing.includes("browser.sidebarReadiness")),
    );
  }
});

test("independent recent page boundaries retain exact 50/51/100/101 membership and continuation", () => {
  for (const total of [50, 51, 100, 101]) {
    const { fixture, observations } = sidebarOracleFixture();
    fixture.cases = { short: fixture.cases.short };
    fixture.multiview = [];
    for (const row of observations.rows.filter((row) => row.path === "/api/sessions"))
      row.data.sessions = row.data.sessions.slice(0, total);
    for (const transport of ["legacy-get", "navigation-post"]) {
      const recent = deriveSidebarReadiness(fixture, observations, sidebarProfile(transport)).actors["actor-a"].recent;
      assert.equal(recent.total, total);
      assert.equal(recent.firstRows.length, 50);
      assert.equal(recent.secondRows.length, Math.min(50, total - 50));
      assert.equal(recent.firstHasMore, total > 50);
      assert.equal(recent.secondHasMore, total > 100);
      assert.deepEqual([...recent.firstRows, ...recent.secondRows], recent.allRows.slice(0, 100));
    }
  }
});
