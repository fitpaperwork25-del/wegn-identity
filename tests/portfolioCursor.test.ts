import assert from "node:assert/strict";
import test from "node:test";
import {
  API_MAJOR_VERSION,
  createPortfolioCursor,
  parsePortfolioCursor,
  resolveCursorStartIndex,
  type CursorSortTuple,
} from "../supabase/functions/_shared/portfolioCursor.ts";

const secret = "cursor-test-secret";
const nowMs = Date.parse("2026-07-23T18:30:00Z");
const tuple: CursorSortTuple = {
  rank: 4,
  latestAttentionAt: null,
  normalizedName: "markato grocery",
  id: "business-a",
};

async function validCursor() {
  return createPortfolioCursor(secret, {
    accountId: "account-a",
    limit: 25,
    lastBusinessId: "business-a",
    lastSort: tuple,
    expiresAt: nowMs + 60_000,
  });
}

test("valid cursor binds account, limit, version, and tuple", async () => {
  const parsed = await parsePortfolioCursor({
    secret,
    value: await validCursor(),
    accountId: "account-a",
    limit: 25,
    nowMs,
  });
  assert.equal(parsed?.apiMajorVersion, API_MAJOR_VERSION);
  assert.deepEqual(parsed?.lastSort, tuple);
});

test("forged cursor fails closed", async () => {
  const cursor = await validCursor();
  assert.equal(await parsePortfolioCursor({
    secret,
    value: `${cursor.slice(0, -1)}x`,
    accountId: "account-a",
    limit: 25,
    nowMs,
  }), null);
});

test("cross-account cursor fails closed", async () => {
  assert.equal(await parsePortfolioCursor({
    secret,
    value: await validCursor(),
    accountId: "account-b",
    limit: 25,
    nowMs,
  }), null);
});

test("expired cursor fails closed", async () => {
  assert.equal(await parsePortfolioCursor({
    secret,
    value: await validCursor(),
    accountId: "account-a",
    limit: 25,
    nowMs: nowMs + 60_001,
  }), null);
});

test("changed limit fails closed", async () => {
  assert.equal(await parsePortfolioCursor({
    secret,
    value: await validCursor(),
    accountId: "account-a",
    limit: 50,
    nowMs,
  }), null);
});

test("changed major version fails closed", async () => {
  assert.equal(await parsePortfolioCursor({
    secret,
    value: await validCursor(),
    accountId: "account-a",
    limit: 25,
    nowMs,
    expectedMajorVersion: "v2",
  }), null);
});

test("removed business invalidates cursor", async () => {
  const parsed = await parsePortfolioCursor({
    secret,
    value: await validCursor(),
    accountId: "account-a",
    limit: 25,
    nowMs,
  });
  assert.ok(parsed);
  assert.equal(resolveCursorStartIndex(parsed, []), null);
});

test("changed sort tuple invalidates cursor", async () => {
  const parsed = await parsePortfolioCursor({
    secret,
    value: await validCursor(),
    accountId: "account-a",
    limit: 25,
    nowMs,
  });
  assert.ok(parsed);
  assert.equal(resolveCursorStartIndex(parsed, [{
    id: "business-a",
    _sort: { ...tuple, rank: 1 },
  }]), null);
});
