import { test } from "node:test";
import assert from "node:assert/strict";
import { nodePostgresUrl } from "../scripts/lib.mjs";

test("libpq's sslrootcert=system is dropped so node-postgres verifies against its built-in roots", () => {
  const url = nodePostgresUrl(
    " postgresql://u:p%40ss@db.example.com:5432/postgres?sslmode=verify-full&sslrootcert=system ",
  );
  assert.equal(url, "postgresql://u:p%40ss@db.example.com:5432/postgres?sslmode=verify-full");
  assert.equal(
    nodePostgresUrl("postgresql://u:p@db.example.com/qm?sslmode=require&sslrootcert=/etc/ca.pem"),
    "postgresql://u:p@db.example.com/qm?sslmode=require&sslrootcert=/etc/ca.pem",
  );
  assert.equal(nodePostgresUrl("postgresql://u:p@db.example.com/qm"), "postgresql://u:p@db.example.com/qm");
});
