import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdminGrantStore, createMemoryAdminGrantPersistence } from "../src/admin/admin-grant-store.ts";

test("grant store: seed applies only when empty and never undoes a revoke", async () => {
  const persist = createMemoryAdminGrantPersistence();
  const seed = [{ principalId: "A", scopeId: "org:default-org", role: "org_admin" as const }];
  const store = createAdminGrantStore(persist, { seed });
  assert.equal((await store.list()).length, 1);
  await store.revoke("A", "org:default-org", "org_admin");
  assert.equal((await store.list()).length, 0);

  await persist.put({ principalId: "B", scopeId: "org:default-org", role: "org_admin" });
  const store2 = createAdminGrantStore(persist, { seed });
  assert.deepEqual(
    (await store2.list()).map((g) => g.principalId),
    ["B"],
  );
});

test("grant store: an empty seed grants no admins (deliberate lock-out)", async () => {
  const store = createAdminGrantStore(createMemoryAdminGrantPersistence(), { seed: [] });
  assert.deepEqual(await store.list(), []);
});
