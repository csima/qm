import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { installPrincipalLinks } from "../src/directory/person.ts";
import { createPrincipalLinkService } from "../src/identity/principal-links.ts";
import { openConversationFor } from "../src/slack/delivery.ts";

afterEach(() => installPrincipalLinks(null));

test("DM and group delivery resolves verified sign-in aliases to Slack identities", async () => {
  const links = createPrincipalLinkService();
  for (const [principalId, canonicalId] of [
    ["oidc:issuer:alice", "alice@example.test"],
    ["oidc:issuer:bob", "W123BOB"],
  ]) {
    await links.link({ principalId, canonicalId, evidence: "Verified test identities", linkedBy: "admin" });
  }
  await links.link({
    principalId: "U123DANA",
    canonicalId: "oidc:issuer:dana",
    evidence: "Verified self-service Slack connection",
    linkedBy: "self-service",
  });
  installPrincipalLinks(links);
  const emails: string[] = [];
  const recipients: string[] = [];
  const client = {
    users: {
      async lookupByEmail({ email }: { email: string }) {
        emails.push(email);
        return { user: { id: "U123ALICE" } };
      },
    },
    conversations: {
      async open({ users }: { users: string }) {
        recipients.push(users);
        return { channel: { id: "D123" } };
      },
    },
  };
  assert.equal(await openConversationFor(client, ["oidc:issuer:alice"]), "D123");
  assert.equal(await openConversationFor(client, ["oidc:issuer:alice", "oidc:issuer:bob", "U123CAROL"]), "D123");
  assert.equal(await openConversationFor(client, ["oidc:issuer:dana"]), "D123");
  assert.deepEqual(emails, ["alice@example.test", "alice@example.test"]);
  assert.deepEqual(recipients, ["U123ALICE", "U123ALICE,W123BOB,U123CAROL", "U123DANA"]);
  await links.unlink("U123DANA");
  await assert.rejects(openConversationFor(client, ["oidc:issuer:dana"]), /linked Slack identity/);
  assert.equal(recipients.length, 3);
});

test("an unlinked sign-in cannot be submitted as a Slack user ID", async () => {
  let calls = 0;
  const client = {
    conversations: {
      async open() {
        calls++;
        return { channel: { id: "D123" } };
      },
    },
  };
  await assert.rejects(openConversationFor(client, ["oidc:issuer:unlinked"]), {
    message: /linked Slack identity/,
    data: { error: "user_not_found" },
  });
  assert.equal(calls, 0);
});
