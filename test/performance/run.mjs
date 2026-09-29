import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ATTACHMENT, BLOCKING_SELECTORS, buildCatalog, cellsFor, chatReady, multiviewState } from "./catalog.mjs";
import { sha256, verifyRun } from "./verify.mjs";

const sourcePath = fileURLToPath(import.meta.url);
const INTERACTIVE_KINDS = new Set([
  "earlier",
  "sidebar-switch",
  "sidebar-more",
  "admin-next",
  "web-overlay",
  "hidden-tab",
  "attachment",
  "disabled-crons",
  "memory-facts",
]);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const plainError = (error) => ({
  name: error?.name ?? "Error",
  message: String(error?.message ?? error).slice(0, 3000),
  stack: typeof error?.stack === "string" ? error.stack.slice(0, 12000) : undefined,
});

export function validateReadySpec(spec) {
  assert.ok(spec && typeof spec.root === "string" && spec.root.length, "Readiness needs an explicit rendered root");
  assert.deepEqual(spec.missing ?? [], [], "Fixture lacks required readiness data");
  assert.ok(
    (Array.isArray(spec.texts) &&
      spec.texts.length &&
      spec.texts.every((text) => typeof text === "string" && text.trim().length > 0)) ||
      (Array.isArray(spec.values) &&
        spec.values.length &&
        spec.values.every((entry) => typeof entry.selector === "string" && typeof entry.value === "string")) ||
      (spec.visible && (spec.editable || spec.enabled)),
    "Readiness needs fixture content or a fixture-specific visible target and usable control",
  );
  assert.ok(!["body", "html"].includes(spec.root) || spec.visible, "Document-only readiness is forbidden");
}

export async function waitReady(page, specs) {
  for (const spec of [specs].flat()) {
    validateReadySpec(spec);
    const root = page.locator(spec.root).first();
    await root.waitFor({ state: "visible" });
    for (const text of spec.texts ?? [])
      await root.getByText(text, { exact: false }).first().waitFor({ state: "visible" });
    for (const text of spec.absentTexts ?? [])
      await root.getByText(text, { exact: false }).first().waitFor({ state: "hidden" });
    for (const selector of spec.absentSelectors ?? [])
      await root.locator(selector).first().waitFor({ state: "hidden" });
    for (const row of spec.rowTexts ?? []) {
      let locator = root.locator(row.selector);
      for (const text of row.texts) locator = locator.filter({ hasText: text });
      await locator.first().waitFor({ state: "visible" });
    }
    for (const { selector, value } of spec.values ?? []) {
      await root.locator(selector).first().waitFor({ state: "attached" });
      await page.waitForFunction(
        ({ rootSelector, selector, value }) =>
          [...globalThis.document.querySelectorAll(rootSelector)].some(
            (element) => element.getBoundingClientRect().width > 0 && element.querySelector(selector)?.value === value,
          ),
        { rootSelector: spec.root, selector, value },
      );
    }
    if (spec.visible) await root.locator(spec.visible).first().waitFor({ state: "visible" });
    if (spec.editable) {
      const input = root
        .locator(spec.editable)
        .and(page.locator(':not(:disabled):not([readonly]):not([aria-disabled="true"])'))
        .filter({ visible: true })
        .first();
      await input.waitFor({ state: "visible" });
      assert.ok(await input.isEditable(), "Composer is not editable");
    }
    if (spec.enabled) {
      const control = root
        .locator(spec.enabled)
        .and(page.locator(':not(:disabled):not([aria-disabled="true"])'))
        .filter({ visible: true })
        .first();
      await control.waitFor({ state: "visible" });
      assert.ok(await control.isEnabled(), "Required control is disabled");
    }
    if (spec.rows) {
      assert.ok(
        Number.isInteger(spec.rows.minimum) && spec.rows.minimum > 0,
        "Row readiness requires a positive minimum",
      );
      await page.waitForFunction(
        ({ rootSelector, selector, minimum }) =>
          [...globalThis.document.querySelectorAll(rootSelector)].some(
            (element) =>
              element.getBoundingClientRect().width > 0 && element.querySelectorAll(selector).length >= minimum,
          ),
        { rootSelector: spec.root, selector: spec.rows.selector, minimum: spec.rows.minimum },
      );
    }
  }
  await page.locator(BLOCKING_SELECTORS).first().waitFor({ state: "hidden" });
  assert.equal(
    await page.locator('[role="alert"]:visible:not(.dv-live-region-assertive:empty)').count(),
    0,
    "The page shows an error alert",
  );
  await page.evaluate(
    () => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))),
  );
}

export async function waitSidebarReady(page, spec, { limit = 50, retainedIds = [] } = {}) {
  assert.equal(spec.schemaVersion, 1);
  assert.equal(spec.surface, "web", "A dynamic all-surface sidebar needs a separate admitted oracle");
  assert.ok(["legacy-get", "navigation-post"].includes(spec.transport));
  assert.match(spec.sourceRevision, /^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(limit) && limit >= 50 && limit <= 5000 && limit % 50 === 0);
  const allowed = new Set(spec.allowedOffPageRows.map((row) => row.id));
  assert.ok(
    retainedIds.every((id) => allowed.has(id)),
    "Unobserved retained sidebar identity",
  );
  const kept = new Set(retainedIds);
  const recent = spec.recent.allRows.filter((row, index) => index < limit || kept.has(row.id));
  const groups = spec.groups.items.filter(
    (group) =>
      spec.transport === "navigation-post" || group.count === 0 || recent.some((row) => row.scopeId === group.scopeId),
  );
  const groupedScopes = new Set(groups.map((group) => group.scopeId));
  const label = (value) => value.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
  const expected = {
    transport: spec.transport,
    recent: recent.map((row) => ({
      id: row.id,
      group: groupedScopes.has(row.scopeId) ? row.scopeId : "",
      title: label(groupedScopes.has(row.scopeId) ? row.groupedTitle : row.title),
    })),
    pinned: spec.pinned.rows.map((row) => ({ id: row.id, title: label(row.title) })),
    groups: groups.map((group) => ({
      scopeId: group.scopeId,
      name: label((group.name ?? { channel: "Channel", group: "Group DM" }[group.kind] ?? "Project").replace(/^#/, "")),
      count: group.count,
    })),
    totals: { recent: spec.recent.total, pinned: spec.pinned.total, groups: spec.groups.total },
    loaded: {
      recent: Math.min(limit, spec.recent.total),
      pinned: spec.pinned.rows.length,
      groups: spec.groups.items.length,
    },
    more: {
      recent:
        spec.transport === "navigation-post"
          ? spec.recent.total > limit
          : spec.recent.allRows.some((row, index) => index >= limit && !kept.has(row.id)),
      pinned: spec.pinned.hasMore,
      groups: spec.groups.hasMore,
    },
    archivedCount: spec.archivedCount,
  };
  const result = await page.waitForFunction((expected) => {
    const root = globalThis.document.querySelector("#sidebar-body");
    if (!root || !root.getClientRects().length) return false;
    const visible = (element) => Boolean(element?.getClientRects().length);
    const label = (value) => value?.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const bounded = expected.transport === "navigation-post";
    if (bounded) {
      if (
        root.dataset.sessionNavigation !== "ready" ||
        root.dataset.sessionNavigationMode !== "bounded" ||
        root.getAttribute("aria-busy") !== "false" ||
        root.dataset.sessionNavigationPending !== ""
      )
        return false;
      for (const section of ["recent", "pinned", "groups"]) {
        const name = section[0].toUpperCase() + section.slice(1);
        if (
          root.dataset[`session${name}Loaded`] !== String(expected.loaded[section]) ||
          root.dataset[`session${name}Total`] !== String(expected.totals[section])
        )
          return false;
      }
    }
    const scope = (element) => {
      if (!element) return "";
      if (bounded) return element.dataset.scopeId;
      const key = element.querySelector(".recent-project-menu [data-menu-id]")?.getAttribute("data-menu-id");
      return key?.startsWith("project:") ? key.slice(8) : undefined;
    };
    const rows = [...root.querySelectorAll(".session-row[data-session-id]")].filter(visible);
    if (new Set(rows.map((row) => row.dataset.sessionId)).size !== rows.length) return false;
    const pinned = [],
      recent = [];
    for (const row of rows) {
      if (row.closest(".archived-children")) return false;
      const link = row.querySelector("a.session");
      if (!visible(link) || link.getAttribute("aria-busy") === "true") return false;
      const item = { id: row.dataset.sessionId, title: label(row.querySelector(".tl")?.textContent) };
      if (row.closest(".pinned-children")) pinned.push(item);
      else recent.push({ ...item, group: scope(row.closest("section.recent-project")) });
    }
    if (!same(pinned, expected.pinned) || recent.length !== expected.recent.length) return false;
    for (const group of new Set(["", ...expected.groups.map((row) => row.scopeId)])) {
      const project = (rows) => rows.filter((row) => row.group === group).map(({ id, title }) => ({ id, title }));
      if (!same(project(recent), project(expected.recent))) return false;
    }
    const headers = [...root.querySelectorAll("section.recent-project")].filter(visible).map((element) => ({
      scopeId: scope(element),
      name: label(element.querySelector(".recent-project-name")?.textContent),
      count: Number(element.querySelector(".recent-project-count")?.textContent),
    }));
    if (!same(headers, expected.groups)) return false;
    for (const section of ["recent", "pinned", "groups"]) {
      const controls = bounded
        ? [...root.querySelectorAll(`[data-session-page="${section}"]`)].filter(visible)
        : [...root.querySelectorAll("button")].filter(
            (button) =>
              visible(button) && section === "recent" && button.textContent.trim() === "Show more conversations",
          );
      if (
        controls.length !== Number(expected.more[section]) ||
        controls.some((button) => button.disabled || button.getAttribute("aria-disabled") === "true")
      )
        return false;
    }
    const archived = [...root.querySelectorAll(".archived-count")].filter(visible);
    if (
      archived.length !== Number(expected.archivedCount > 0) ||
      (archived.length && archived[0].textContent.trim() !== String(expected.archivedCount))
    )
      return false;
    if ([...root.querySelectorAll('[role="alert"]')].some(visible)) return false;
    return { recent, pinned, groups: headers, archivedCount: expected.archivedCount };
  }, expected);
  return result.jsonValue();
}

export function validateConfig(config) {
  const url = new URL(config.baseUrl);
  assert.ok(
    ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "baseUrl must be a plain origin",
  );
  assert.equal(config.isolated, true, "An explicitly isolated fixture is required; never use production");
  assert.ok(["diagnostic", "qualifying"].includes(config.mode), "mode must be explicit");
  assert.ok(["normal", "peak", "burst"].includes(config.loadCondition), "loadCondition must be normal, peak or burst");
  assert.ok(
    Number.isInteger(config.samples) && config.samples > 0 && config.samples <= 1000,
    "samples must be 1..1000",
  );
  assert.ok(
    config.mode !== "qualifying" || (config.samples >= 31 && !config.filter),
    "Qualifying runs need >=31 samples and the full catalog",
  );
  assert.ok(
    config.cacheFilter === undefined || (config.mode === "diagnostic" && ["cold", "warm"].includes(config.cacheFilter)),
    "cacheFilter is supported only for explicit diagnostic cache modes",
  );
  assert.ok(
    typeof config.sourceRevision === "string" && /^[a-f0-9]{40}$/.test(config.sourceRevision),
    "An exact source revision is required",
  );
  assert.ok(
    config.browser?.viewport?.width > 0 && config.browser?.viewport?.height > 0,
    "Set a browser viewport explicitly",
  );
  assert.ok(
    Number.isFinite(config.browser?.cpuThrottleRate) && config.browser.cpuThrottleRate >= 1,
    "Set cpuThrottleRate explicitly",
  );
  const network = config.browser?.network;
  assert.ok(
    network &&
      Number.isFinite(network.latencyMs) &&
      network.latencyMs >= 0 &&
      network.downloadBytesPerSecond > 0 &&
      network.uploadBytesPerSecond > 0,
    "Set explicit network latency and throughput",
  );
  assert.ok(
    !config.connectOverCDP && !config.userDataDir && !config.channel,
    "Existing user browser profiles are never used",
  );
}

function shuffle(array, seed) {
  let state = seed >>> 0;
  for (let i = array.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const navigate = (page, baseUrl, path) => page.goto(new URL(path, baseUrl).href, { waitUntil: "domcontentloaded" });
const sessionLink = (page, session) =>
  page
    .locator(`[data-session-id=${JSON.stringify(session.sessionId)}] a.session`)
    .filter({ visible: true })
    .first();

export async function establishSplitState(request, baseUrl, principalId, value) {
  const me = await request.get(new URL("/me", baseUrl).href);
  assert.ok(me.ok(), "Fixture authentication setup failed");
  assert.equal((await me.json()).user, principalId, "Refusing to change another principal's UI state");
  const url = new URL("/api/ui-state?key=split-canvas", baseUrl).href;
  const prior = await request.get(url);
  assert.ok(prior.ok(), "Cannot read fixture UI state");
  const old = await prior.json();
  assert.ok(Number.isSafeInteger(old.updatedAt) && old.updatedAt >= 0, "Invalid UI state timestamp");
  const updatedAt = Math.max(Date.now(), old.updatedAt + 1);
  const state = { ...value, updatedAt };
  const saved = await request.put(new URL("/api/ui-state", baseUrl).href, {
    headers: { origin: new URL(baseUrl).origin },
    data: { key: "split-canvas", value: state, updatedAt },
  });
  assert.ok(saved.ok() && (await saved.json()).ok, "Fixture UI state write was rejected");
  const response = await request.get(url);
  assert.ok(response.ok(), "Cannot verify fixture UI state");
  const verified = await response.json();
  assert.deepEqual(verified.value, state, "Fixture UI state was not persisted exactly");
  return { ...state, updatedAt: verified.updatedAt };
}

async function prepare(page, scenario, cache, baseUrl) {
  const interact = INTERACTIVE_KINDS.has(scenario.kind);
  let limit = 50;
  if (cache === "cold" && !interact) return { limit, prepared: false };
  await navigate(page, baseUrl, scenario.path);
  if (scenario.sidebarReadiness)
    await waitSidebarReady(page, scenario.sidebarReadiness, { retainedIds: sidebarRetainedIds(scenario, true) });
  if (scenario.kind === "earlier") {
    await waitReady(page, scenario.prepareReady);
    for (const ready of scenario.preparePages ?? []) {
      await page.getByRole("button", { name: "Show earlier messages", exact: true }).first().click();
      await waitReady(page, ready);
    }
    for (const selector of scenario.prepareReady.absentSelectors ?? [])
      assert.equal(await page.locator(selector).count(), 0, "Measured earlier-page target is already rendered");
    await page
      .getByRole("button", { name: "Show earlier messages", exact: true })
      .first()
      .waitFor({ state: "visible" });
  } else if (scenario.kind === "sidebar-switch") {
    await waitReady(page, scenario.prepareReady);
    for (let attempts = 0; !(await sessionLink(page, scenario.session).count()); attempts++) {
      assert.ok(attempts < 100, "Sidebar target is absent after 100 pages");
      await page.getByRole("button", { name: "Show more conversations", exact: true }).click();
      limit += 50;
      await waitSidebarReady(page, scenario.sidebarReadiness, {
        limit,
        retainedIds: sidebarRetainedIds(scenario, true),
      });
    }
    await sessionLink(page, scenario.session).waitFor({ state: "visible" });
  } else if (scenario.kind === "sidebar-more") {
    await page.locator(".settings-page").waitFor({ state: "visible" });
    await page
      .getByRole("button", { name: "Show more conversations", exact: true })
      .first()
      .waitFor({ state: "visible" });
    assert.equal(
      await page.locator(scenario.ready.visible).filter({ visible: true }).count(),
      0,
      "Pagination target is already visible on the first page",
    );
  } else if (scenario.kind === "hidden-tab") {
    await waitReady(
      page,
      scenario.visibleIndices.map((i) => chatReady(scenario.sessions[i], `perf-pane-${i}`)),
    );
    await page.getByRole("tab").filter({ hasText: scenario.sessions[0].title }).first().click();
    await waitReady(page, scenario.ready);
    await page
      .getByRole("tab")
      .filter({ hasText: scenario.sessions[scenario.visibleIndices[0]].title })
      .first()
      .click();
    await waitReady(
      page,
      chatReady(scenario.sessions[scenario.visibleIndices[0]], `perf-pane-${scenario.visibleIndices[0]}`),
    );
  } else if (scenario.kind === "web-overlay") {
    await page.locator(".custom-chat textarea:visible").first().waitFor({ state: "visible" });
  } else {
    await waitReady(page, scenario.prepareReady ?? scenario.ready);
  }
  return { limit, prepared: true };
}

function sidebarRetainedIds(scenario, preparation = false) {
  if (["multiview", "hidden-tab"].includes(scenario.kind)) return scenario.sessions.map((session) => session.sessionId);
  if (preparation && scenario.kind === "sidebar-switch") return [decodeURIComponent(scenario.path.slice(3))];
  return scenario.session ? [scenario.session.sessionId] : [];
}

export function sidebarRequirements(spec, { optional = false, cursorSha256 } = {}) {
  if (spec.transport === "legacy-get") return ["/api/sessions", "/api/contexts"].map((path) => ({ path, optional }));
  assert.equal(spec.transport, "navigation-post");
  const common = {
    path: "/api/session-navigation",
    method: "POST",
    navigation: { surface: spec.surface },
    captureNavigation: true,
    allowSupersededAbort: true,
    optional,
  };
  return [
    {
      ...common,
      navigation: {
        ...common.navigation,
        section: cursorSha256 ? "recent" : null,
        cursorSha256: cursorSha256 ?? null,
      },
      optional: cursorSha256 ? false : optional,
    },
    common,
  ];
}

export function validateSidebarEvidence(evidence, spec, previousRequests = []) {
  assert.deepEqual(evidence.errors, [], "Browser/request errors occurred before sidebar completion");
  if (spec.transport === "legacy-get") return;
  assert.equal(
    evidence.requests.some((entry) => entry.sameOrigin && entry.path === "/api/sessions"),
    false,
    "Bounded navigation fell back to the full session list",
  );
  const cursors = new Map([[null, 0]]);
  const allowed = new Set(
    spec.allowedOffPageRows.flatMap((row) => [`id:${sha256(row.id)}`, `thread:${sha256(row.threadRef)}`]),
  );
  for (const entry of [...previousRequests, ...evidence.requests]) {
    if (entry.path !== "/api/session-navigation" || !entry.completed || entry.status !== 200) continue;
    assert.ok(entry.sameOrigin && entry.method === "POST");
    assert.ok(entry.navigationPages, "Missing completed navigation page evidence");
    const intent = entry.navigation;
    assert.equal(intent.surface, spec.surface);
    assert.ok([null, "recent"].includes(intent.section), "Unexpected sidebar pagination section");
    for (const ref of intent.references)
      assert.ok(allowed.has(`${ref.kind}:${ref.valueSha256}`), "Navigation referenced an unobserved session");
    const offset = cursors.get(intent.cursorSha256);
    assert.notEqual(offset, undefined, "Navigation cursor has no verified predecessor");
    assert.equal(intent.section === null, intent.cursorSha256 === null);
    const expected = {
      recent: { rows: spec.recent.allRows.slice(offset, offset + 50), total: spec.recent.total },
      pinned: { rows: spec.pinned.rows, total: spec.pinned.total },
      groups: { rows: spec.groups.items, total: spec.groups.total },
    };
    for (const [section, { rows, total }] of Object.entries(expected)) {
      const actual = entry.navigationPages[section];
      assert.equal(
        actual.idsSha256,
        sha256(JSON.stringify(rows.map((row) => row[section === "groups" ? "scopeId" : "id"]))),
      );
      assert.equal(actual.count, rows.length);
      assert.equal(actual.total, total);
      assert.equal(Boolean(actual.nextCursorSha256), total > (section === "recent" ? offset : 0) + rows.length);
    }
    const next = entry.navigationPages.recent.nextCursorSha256;
    if (next) {
      assert.ok(!cursors.has(next) || cursors.get(next) === offset + 50, "Navigation cursor did not advance");
      cursors.set(next, offset + 50);
    }
  }
}

async function action(page, scenario, cache, baseUrl) {
  if (scenario.kind === "attachment")
    await page
      .locator(".custom-chat .file-input")
      .first()
      .setInputFiles({ name: ATTACHMENT.name, mimeType: ATTACHMENT.mimeType, buffer: Buffer.from(ATTACHMENT.text) });
  else if (scenario.kind === "disabled-crons") await page.locator(".cron-disabled-toggle").click();
  else if (scenario.kind === "memory-facts")
    await page.getByRole("button", { name: "Facts view", exact: true }).click();
  else if (scenario.kind === "earlier")
    await page.getByRole("button", { name: "Show earlier messages", exact: true }).first().click();
  else if (scenario.kind === "sidebar-switch") await sessionLink(page, scenario.session).click();
  else if (scenario.kind === "sidebar-more")
    await page.getByRole("button", { name: "Show more conversations", exact: true }).first().click();
  else if (scenario.kind === "admin-next") await page.getByRole("button", { name: "Next →", exact: true }).click();
  else if (scenario.kind === "web-overlay") {
    await page
      .getByRole("button", { name: scenario.overlay === "search" ? "Search" : "Browse", exact: true })
      .first()
      .click();
    if (scenario.overlay === "search") await page.locator(".chat-search-input").fill(scenario.query);
  } else if (scenario.kind === "hidden-tab") {
    const target = page.getByRole("tab").filter({ hasText: scenario.sessions[0].title }).first();
    await target.click();
  } else if (cache === "warm") await page.reload({ waitUntil: "domcontentloaded" });
  else await navigate(page, baseUrl, scenario.path);
}

export function navigationIntent(path, raw) {
  const fields = {
    "/api/session-navigation": ["surface", "section", "cursor", "references"],
    "/api/session-navigation/page": [
      "surface",
      "status",
      "scopeId",
      "parentSessionId",
      "query",
      "title",
      "children",
      "actionable",
      "pinned",
      "archived",
      "cursor",
    ],
    "/api/session-navigation/resolve": ["references"],
  }[path];
  if (!fields) return undefined;
  assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 65536, "Invalid navigation request body");
  const body = JSON.parse(raw);
  assert.ok(body && typeof body === "object" && !Array.isArray(body), "Invalid navigation request body");
  assert.ok(
    Object.keys(body).every((key) => fields.includes(key)),
    "Unknown navigation request field",
  );
  const intent = {};
  for (const field of fields) {
    const value = body[field];
    if (field === "references") {
      assert.ok(value === undefined || (Array.isArray(value) && value.length <= 12), "Invalid navigation references");
      intent.references = (value ?? []).map((ref) => {
        assert.ok(
          ref && typeof ref === "object" && Object.keys(ref).sort().join() === "kind,value",
          "Invalid navigation reference",
        );
        assert.ok(
          ["id", "thread"].includes(ref.kind) &&
            typeof ref.value === "string" &&
            ref.value.length > 0 &&
            ref.value.length <= (ref.kind === "id" ? 512 : 2048),
          "Invalid navigation reference",
        );
        return { kind: ref.kind, valueSha256: sha256(ref.value) };
      });
    } else if (["children", "actionable", "pinned", "archived"].includes(field)) {
      assert.ok(value === undefined || typeof value === "boolean", "Invalid navigation boolean");
      intent[field] = value ?? null;
    } else if (["surface", "section", "status"].includes(field)) {
      const allowed = {
        surface: ["all", "web", "slack", "core"],
        section: ["recent", "pinned", "groups", "archived"],
        status: ["active", "waiting", "archived"],
      }[field];
      assert.ok(value === undefined || allowed.includes(value), "Invalid navigation selection");
      intent[field] = value ?? null;
    } else {
      assert.ok(
        value === undefined || (typeof value === "string" && value.length <= (field === "cursor" ? 4096 : 512)),
        "Invalid navigation text",
      );
      intent[`${field}Sha256`] = value === undefined ? null : sha256(value);
    }
  }
  return intent;
}

function matchesRequest(entry, requirement) {
  return (
    entry.sameOrigin !== false &&
    entry.path === requirement.path &&
    entry.method === (requirement.method ?? "GET") &&
    (!requirement.navigation ||
      (entry.navigation &&
        Object.entries(requirement.navigation).every(
          ([key, value]) =>
            Object.hasOwn(entry.navigation, key) && JSON.stringify(entry.navigation[key]) === JSON.stringify(value),
        )))
  );
}

function navigationPageEvidence(data) {
  const pages = {};
  for (const section of ["recent", "pinned", "groups"]) {
    const page = data?.[section];
    assert.ok(page && Array.isArray(page.items) && page.items.length <= 50);
    assert.ok(Number.isSafeInteger(page.total) && page.total >= page.items.length);
    assert.ok(
      page.nextCursor === null ||
        (typeof page.nextCursor === "string" && page.nextCursor.length > 0 && page.nextCursor.length <= 4096),
    );
    const ids = page.items.map((item) => item?.[section === "groups" ? "scopeId" : "id"]);
    assert.ok(ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 512));
    assert.equal(new Set(ids).size, ids.length);
    pages[section] = {
      idsSha256: sha256(JSON.stringify(ids)),
      count: ids.length,
      total: page.total,
      nextCursorSha256: page.nextCursor === null ? null : sha256(page.nextCursor),
    };
  }
  return pages;
}

export function requiredResponsesComplete(requests, requirements) {
  return requirements.every((requirement) => {
    const matching = requests.filter((entry) => matchesRequest(entry, requirement));
    if (requirement.optional === true && matching.length === 0) return true;
    const succeeded = (entry) =>
      entry.completed &&
      (requirement.expectedStatuses
        ? requirement.expectedStatuses.includes(entry.status)
        : entry.status >= 200 && entry.status < 300) &&
      (!requirement.expectedError || entry.expectedErrorMatched === true);
    return (
      matching.length > 0 &&
      matching.every(
        (entry, index) =>
          succeeded(entry) ||
          (requirement.allowSupersededAbort === true &&
            requirement.navigation &&
            entry.navigation &&
            entry.phase === "failed" &&
            entry.failure === "net::ERR_ABORTED" &&
            (entry.status === undefined || (entry.status >= 200 && entry.status < 300)) &&
            matching
              .slice(index + 1)
              .some(
                (later) => JSON.stringify(later.navigation) === JSON.stringify(entry.navigation) && succeeded(later),
              )),
      ) &&
      (!requirement.captureNavigation || matching.some((entry) => succeeded(entry) && entry.navigationPages)) &&
      (!requirement.paginated || matching.some((entry) => entry.finalPage === true)) &&
      (!requirement.settledField || matching.some((entry) => entry.settled === true)) &&
      (!requirement.followupWhenNonempty ||
        (matching.every((entry) => entry.followupRequired !== undefined) &&
          (!matching.some((entry) => entry.followupRequired) ||
            requiredResponsesComplete(requests, [{ path: requirement.followupPath }]))))
    );
  });
}

export function observe(page, origin, requirements) {
  const requests = [];
  const errors = [];
  const byRequest = new Map();
  const pending = new Set();
  const changed = new Set();
  const notify = () => {
    for (const listener of changed) listener();
  };
  let identity;
  let identityRead = 0;
  let active = false;
  let generation = 0;
  page.on("pageerror", (error) => {
    if (active) errors.push({ type: "pageerror", ...plainError(error) });
  });
  page.on("request", (request) => {
    if (!active) return;
    const url = new URL(request.url());
    const entry = {
      path: url.pathname,
      origin: url.origin,
      sameOrigin: url.origin === origin,
      method: request.method(),
      resourceType: request.resourceType(),
      startedAt: Date.now(),
      timing: request.timing(),
      completed: false,
      phase: "started",
    };
    if (entry.sameOrigin && entry.method === "POST" && entry.path.startsWith("/api/session-navigation")) {
      try {
        entry.navigation = navigationIntent(entry.path, request.postData());
      } catch {
        errors.push({ type: "contract", path: entry.path, message: "Invalid navigation request intent" });
      }
    }
    byRequest.set(request, entry);
    requests.push(entry);
    notify();
  });
  page.on("requestfailed", (request) => {
    const entry = byRequest.get(request);
    if (!active || !entry) return;
    entry.phase = "failed";
    entry.failedAt = Date.now();
    entry.failure = request.failure()?.errorText;
    entry.timing = request.timing();
    if (entry.sameOrigin && entry.failure !== "net::ERR_ABORTED")
      errors.push({ type: "requestfailed", path: entry.path, message: entry.failure });
    notify();
  });
  page.on("response", (response) => {
    const request = response.request();
    const entry = byRequest.get(request);
    if (!active || !entry) return;
    const observedGeneration = generation;
    entry.status = response.status();
    entry.phase = "response";
    entry.responseAt = Date.now();
    entry.timing = request.timing();
    entry.fromServiceWorker = response.fromServiceWorker();
    if (entry.sameOrigin && ["/me", "/admin/api/me"].includes(entry.path)) {
      identity = undefined;
      const observedIdentityRead = ++identityRead;
      if (entry.status === 200) {
        const job = response
          .json()
          .then((data) => {
            if (generation !== observedGeneration) return;
            const principal = data?.principal ?? data?.user;
            if (typeof principal !== "string" || !principal.trim()) throw new Error("Invalid identity");
            if (identityRead === observedIdentityRead) identity = principal;
          })
          .catch(() => {
            if (generation === observedGeneration)
              errors.push({ type: "contract", path: entry.path, message: "Invalid identity response" });
          });
        pending.add(job);
        void job.finally(() => pending.delete(job));
      }
    }
    const requirement = requirements.find((item) => matchesRequest(entry, item));
    if (
      entry.sameOrigin &&
      requirement &&
      (requirement.paginated ||
        requirement.captureNavigation ||
        requirement.settledField ||
        requirement.followupWhenNonempty ||
        requirement.expectedError)
    ) {
      const job = response
        .json()
        .then((data) => {
          if (generation !== observedGeneration) return;
          if (requirement.captureNavigation) {
            try {
              entry.navigationPages = navigationPageEvidence(data);
            } catch {
              errors.push({ type: "contract", path: entry.path, message: "Invalid navigation page envelope" });
            }
          }
          if (requirement.paginated) entry.finalPage = Array.isArray(data.items) && !data.nextCursor;
          if (requirement.settledField) entry.settled = !data[requirement.settledField];
          if (requirement.followupWhenNonempty)
            entry.followupRequired = (data[requirement.followupWhenNonempty]?.length ?? 0) > 0;
          if (requirement.expectedError) {
            entry.errorCode = data.error;
            entry.expectedErrorMatched =
              requirement.expectedStatuses.includes(entry.status) && data.error === requirement.expectedError;
          }
          notify();
        })
        .catch(() => {})
        .then(() => {
          if (generation !== observedGeneration) return;
          if (requirement.expectedError && !entry.expectedErrorMatched)
            errors.push({
              type: "contract",
              path: entry.path,
              status: entry.status,
              message: "Response did not match the declared disabled-feature contract",
            });
        });
      pending.add(job);
      void job.finally(() => pending.delete(job));
    }
    if (entry.sameOrigin && entry.status >= 400 && !requirement?.expectedError)
      errors.push({ type: "http", path: entry.path, status: entry.status });
    const job = response
      .allHeaders()
      .then((headers) => {
        if (generation !== observedGeneration) return;
        entry.encoding = headers["content-encoding"] ?? null;
        entry.contentLength = headers["content-length"] ? Number(headers["content-length"]) : null;
        entry.serverTiming = headers["server-timing"] ?? null;
        entry.contentType = headers["content-type"] ?? null;
      })
      .catch((error) => {
        if (generation === observedGeneration) errors.push({ type: "headers", ...plainError(error) });
      });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  page.on("requestfinished", (request) => {
    const entry = byRequest.get(request);
    if (!active || !entry) return;
    const observedGeneration = generation;
    entry.phase = "finished";
    entry.finishedAt = Date.now();
    const job = request
      .sizes()
      .then((sizes) => {
        if (generation !== observedGeneration) return;
        entry.bytes = sizes;
        entry.timing = request.timing();
        entry.completed = true;
        notify();
      })
      .catch(() => {});
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  return {
    async waitResponses(timeoutMs) {
      if (requiredResponsesComplete(requests, requirements)) return;
      await new Promise((resolve, reject) => {
        const done = () => {
          if (!requiredResponsesComplete(requests, requirements)) return;
          clearTimeout(timer);
          changed.delete(done);
          resolve();
        };
        const timer = setTimeout(() => {
          changed.delete(done);
          const unfinished = requirements.filter((requirement) => !requiredResponsesComplete(requests, [requirement]));
          reject(
            new Error(`Required page requests did not finish: ${unfinished.map((entry) => entry.path).join(", ")}`),
          );
        }, timeoutMs);
        changed.add(done);
        done();
      });
    },
    start(nextRequirements = requirements, { reuseIdentity = false } = {}) {
      if (reuseIdentity) assert.ok(typeof identity === "string" && identity, "No verified identity to reuse");
      else identity = undefined;
      requirements = nextRequirements;
      generation++;
      byRequest.clear();
      pending.clear();
      requests.length = 0;
      errors.length = 0;
      active = true;
    },
    async finish() {
      active = false;
      await Promise.all(pending);
      const now = Date.now();
      for (const entry of requests)
        if (!entry.completed && entry.phase !== "failed") entry.pendingForMs = now - entry.startedAt;
      return structuredClone({ requests, errors, identity });
    },
  };
}

async function sample(browser, config, scenario, cell, iteration, output) {
  const result = {
    schemaVersion: 1,
    cellId: cell.id,
    scenarioId: scenario.id,
    cache: cell.cache,
    condition: cell.condition,
    iteration,
    status: "failed",
    startedAt: Date.now(),
    finishedAt: null,
    durationMs: null,
  };
  let context;
  let measurementStart;
  let observer;
  try {
    if (scenario.missing.length) {
      result.status = "unsupported";
      throw new Error(`Fixture prerequisites missing: ${scenario.missing.join(", ")}`);
    }
    for (const spec of [scenario.ready, scenario.prepareReady].flat().filter(Boolean)) validateReadySpec(spec);
    const sidebar = scenario.sidebarReadiness;
    if (!scenario.admin) {
      assert.ok(sidebar, "Missing independent sidebar readiness");
      assert.equal(sidebar.sourceRevision, config.sourceRevision, "Sidebar oracle belongs to different source");
      assert.deepEqual(config.sidebarProfile, {
        transport: sidebar.transport,
        sourceRevision: config.sourceRevision,
      });
    }
    const storageState =
      config.authStates?.[scenario.principalId] ?? (scenario.admin ? config.adminAuthState : undefined);
    assert.ok(
      storageState || config.localAuthPrincipal === scenario.principalId,
      `No authentication state for ${scenario.principalId}`,
    );
    context = await browser.newContext({
      viewport: config.browser.viewport,
      locale: "en-US",
      timezoneId: "UTC",
      serviceWorkers: "block",
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs ?? 15_000);
    page.setDefaultNavigationTimeout(config.timeoutMs ?? 15_000);
    const session = await context.newCDPSession(page);
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: config.browser.network.latencyMs,
      downloadThroughput: config.browser.network.downloadBytesPerSecond,
      uploadThroughput: config.browser.network.uploadBytesPerSecond,
    });
    await session.send("Emulation.setCPUThrottlingRate", { rate: config.browser.cpuThrottleRate });
    const state = await establishSplitState(
      context.request,
      config.baseUrl,
      scenario.principalId,
      ["multiview", "hidden-tab"].includes(scenario.kind)
        ? multiviewState(scenario.sessions, 0, scenario.visibleGroups)
        : { v: 2, active: false },
    );
    result.uiStateSetup = {
      principalId: scenario.principalId,
      updatedAt: state.updatedAt,
      sha256: sha256(JSON.stringify(state)),
    };
    await page.addInitScript(
      ({ origin, state }) => {
        if (globalThis.location.origin === origin)
          globalThis.localStorage.setItem("web-ui:split-canvas:v1", JSON.stringify(state));
        globalThis.__qmPerformance = { longTasks: [] };
        new globalThis.PerformanceObserver((list) =>
          globalThis.__qmPerformance.longTasks.push(
            ...list.getEntries().map((entry) => ({ startTime: entry.startTime, duration: entry.duration })),
          ),
        ).observe({ type: "longtask", buffered: true });
      },
      { origin: config.baseUrl, state },
    );
    const common = sidebar ? [{ path: "/me" }, ...sidebarRequirements(sidebar)] : [];
    const preparationRequirements = [...(scenario.kind === "web-overlay" ? [] : scenario.requiredResponses), ...common];
    observer = observe(page, config.baseUrl, preparationRequirements);
    observer.start();
    const preparation = await prepare(page, scenario, cell.cache, config.baseUrl);
    if (preparation.prepared) {
      await observer.waitResponses(config.timeoutMs ?? 15_000);
      const sidebarState = sidebar
        ? await waitSidebarReady(page, sidebar, {
            limit: preparation.limit,
            retainedIds: sidebarRetainedIds(scenario, true),
          })
        : undefined;
      result.preparation = { ...(await observer.finish()), sidebar: sidebarState };
      assert.equal(result.preparation.identity, scenario.principalId, "Preparation authenticated the wrong principal");
      assert.deepEqual(result.preparation.errors, [], "Browser/request errors occurred during preparation");
      if (sidebar) validateSidebarEvidence(result.preparation, sidebar);
    }
    const interactive = INTERACTIVE_KINDS.has(scenario.kind);
    let cursorSha256;
    if (scenario.kind === "sidebar-more" && sidebar.transport === "navigation-post") {
      cursorSha256 = result.preparation.requests.findLast(
        (entry) => entry.completed && entry.navigation?.section === null && entry.navigationPages,
      )?.navigationPages.recent.nextCursorSha256;
      assert.match(cursorSha256 ?? "", /^[a-f0-9]{64}$/, "Sidebar page two has no verified continuation");
    }
    const interactiveSidebarRequirements = sidebar
      ? sidebarRequirements(sidebar, { optional: true, cursorSha256 })
      : [];
    const measuredRequirements = [
      ...scenario.requiredResponses,
      ...(interactive ? interactiveSidebarRequirements : common),
    ];
    if (interactive)
      await page.evaluate(() => {
        performance.clearResourceTimings();
        globalThis.__qmPerformance.longTasks = [];
      });
    result.startedAt = Date.now();
    measurementStart = performance.now();
    observer.start(measuredRequirements, { reuseIdentity: interactive });
    await action(page, scenario, cell.cache, config.baseUrl);
    await observer.waitResponses(config.timeoutMs ?? 15_000);
    await waitReady(page, scenario.ready);
    if (sidebar)
      result.sidebar = await waitSidebarReady(page, sidebar, {
        limit: interactive ? preparation.limit + (scenario.kind === "sidebar-more" ? 50 : 0) : 50,
        retainedIds: sidebarRetainedIds(scenario),
      });
    await observer.waitResponses(config.timeoutMs ?? 15_000);
    result.durationMs = performance.now() - measurementStart;
    result.finishedAt = Date.now();
    result.readiness = { passed: true, completedAt: result.finishedAt, assertions: scenario.ready };
    result.browser = await page.evaluate(() => ({
      navigation: performance.getEntriesByType("navigation").map((entry) => entry.toJSON()),
      resources: performance.getEntriesByType("resource").map((entry) => ({
        path: new URL(entry.name).pathname,
        initiatorType: entry.initiatorType,
        startTime: entry.startTime,
        duration: entry.duration,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
      })),
      longTasks: globalThis.__qmPerformance.longTasks,
      domNodes: globalThis.document.querySelectorAll("*").length,
      visibleSessionRows: [...globalThis.document.querySelectorAll("[data-session-id]")].filter(
        (element) => element.getBoundingClientRect().width > 0,
      ).length,
    }));
    for (const navigation of result.browser.navigation) delete navigation.name;
    const evidence = await observer.finish();
    Object.assign(result, evidence);
    result.requiredResponses = measuredRequirements;
    assert.equal(evidence.identity, scenario.principalId, "Browser is authenticated as the wrong fixture principal");
    assert.deepEqual(evidence.errors, [], "Browser/request errors occurred during measurement");
    if (sidebar) validateSidebarEvidence(evidence, sidebar, interactive ? result.preparation.requests : []);
    result.status = "pass";
  } catch (error) {
    result.error = plainError(error);
    if (measurementStart !== undefined && result.durationMs === null)
      result.durationMs = performance.now() - measurementStart;
    result.finishedAt ??= Date.now();
    if (observer) Object.assign(result, await observer.finish());
    if (context) {
      const page = context.pages()[0];
      if (page) {
        result.finalUrl = page.url();
        result.visibleAlerts = await page
          .locator('[role="alert"]:visible')
          .evaluateAll((elements) =>
            elements.map((element) => ({
              text: element.textContent?.slice(0, 3000) ?? "",
              outerHTML: element.outerHTML.slice(0, 5000),
              bounds: element.getBoundingClientRect().toJSON(),
            })),
          )
          .catch(() => []);
        await page
          .screenshot({
            path: resolve(output, `failure-${cell.id.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}-${iteration}.png`),
            timeout: 3000,
          })
          .catch(() => {});
      }
    }
  } finally {
    if (context) await context.close();
  }
  return result;
}

export async function run(configPath, listOnly = false) {
  const configDirectory = dirname(resolve(configPath));
  const config = json(resolve(configPath));
  validateConfig(config);
  config.baseUrl = new URL(config.baseUrl).origin;
  const fromConfig = (path) => resolve(configDirectory, path);
  const fixtureBytes = readFileSync(fromConfig(config.fixturePath));
  const fixture = JSON.parse(fixtureBytes);
  const profiles = (config.profilePaths ?? [config.profilePath]).flatMap((path) => {
    const value = json(fromConfig(path));
    return Array.isArray(value) ? value : [value];
  });
  const profileHash = sha256(JSON.stringify(profiles));
  assert.ok(typeof fixture.fixtureId === "string" && fixture.fixtureId, "Fixture identity is required");
  assert.equal(fixture.profileSha256, profileHash, "Fixture was seeded from a different profile");
  const catalog = buildCatalog(fixture);
  const selected = config.filter ? catalog.filter((scenario) => new RegExp(config.filter).test(scenario.id)) : catalog;
  assert.ok(selected.length, "No catalog scenarios matched");
  if (listOnly) {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }
  for (const key of Object.keys(config.authStates ?? {})) config.authStates[key] = fromConfig(config.authStates[key]);
  if (config.adminAuthState) config.adminAuthState = fromConfig(config.adminAuthState);
  if (config.localAuthPrincipal)
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.baseUrl).hostname),
      "Local auth is only permitted on loopback",
    );
  const output = fromConfig(config.outDir);
  assert.ok(
    !existsSync(resolve(output, "run.json")),
    "Refusing to replace previous evidence; choose a fresh output directory",
  );
  mkdirSync(output, { recursive: true });
  const write = (name, value) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n");
  const cells = cellsFor(selected, config.loadCondition).filter(
    (cell) => !config.cacheFilter || cell.cache === config.cacheFilter,
  );
  const startedAt = Date.now();
  const runState = {
    schemaVersion: 1,
    runId: randomUUID(),
    mode: config.mode,
    baseUrl: config.baseUrl,
    fixtureId: fixture.fixtureId,
    sourceRevision: config.sourceRevision,
    profileSha256: profileHash,
    fixtureSha256: sha256(fixtureBytes),
    catalogSha256: sha256(readFileSync(resolve(dirname(sourcePath), "catalog.mjs"))),
    runnerSha256: sha256(readFileSync(sourcePath)),
    samplesPerCell: config.samples,
    thresholdMs: 1000,
    loadCondition: config.loadCondition,
    filtered: Boolean(config.filter || config.cacheFilter),
    browser: config.browser,
    requiredCells: cells.map((cell) => cell.id),
    catalog: selected,
    startedAt,
    status: "running",
    measurementStartedAt: startedAt,
    measurementFinishedAt: null,
  };
  write("run.json", runState);
  write("fixture.json", fixture);
  const envelope = config.envelopePath ? json(fromConfig(config.envelopePath)) : undefined;
  if (envelope) write("envelope.json", envelope);
  if (config.mode === "qualifying") {
    assert.ok(
      envelope?.isolated && envelope.baseUrl === config.baseUrl && envelope.fixtureId === fixture.fixtureId,
      "Qualification requires matching isolated environment evidence before browser launch",
    );
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    ...(config.executablePath ? { executablePath: fromConfig(config.executablePath) } : {}),
  });
  runState.browserVersion = browser.version();
  const samples = [];
  try {
    for (let iteration = 0; iteration < config.samples; iteration++) {
      for (const cell of shuffle([...cells], (config.orderSeed ?? 7349) + iteration)) {
        const scenario = selected.find((entry) => entry.id === cell.scenarioId);
        const observation = await sample(browser, config, scenario, cell, iteration, output);
        samples.push(observation);
        appendFileSync(resolve(output, "samples.jsonl"), JSON.stringify(observation) + "\n");
        console.log(
          JSON.stringify({
            cell: cell.id,
            iteration,
            status: observation.status,
            durationMs: observation.durationMs,
            error: observation.error?.message,
          }),
        );
      }
    }
    runState.status = "completed";
  } finally {
    runState.measurementStartedAt = samples.length ? Math.min(...samples.map((entry) => entry.startedAt)) : startedAt;
    runState.measurementFinishedAt = samples.length
      ? Math.max(...samples.map((entry) => entry.finishedAt))
      : Date.now();
    runState.finishedAt = Date.now();
    write("run.json", runState);
    await browser.close();
  }
  const workload =
    config.workloadPath && existsSync(fromConfig(config.workloadPath))
      ? json(fromConfig(config.workloadPath))
      : undefined;
  if (workload) write("workload.json", workload);
  const producer =
    config.producerPath && existsSync(fromConfig(config.producerPath))
      ? json(fromConfig(config.producerPath))
      : undefined;
  if (producer) write("producer.json", producer);
  const summary = verifyRun(runState, samples, fixture, envelope, workload, producer);
  write("summary.json", summary);
  console.log(
    JSON.stringify({
      output,
      pass: summary.pass,
      qualified: summary.qualified,
      reasons: summary.reasons,
      qualificationReasons: summary.qualificationReasons,
    }),
  );
  process.exitCode = (config.mode === "qualifying" ? summary.qualified : summary.pass) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === sourcePath)
  await run(process.argv[2], process.argv.includes("--list"));
