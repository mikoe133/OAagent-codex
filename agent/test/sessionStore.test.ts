import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/infrastructure/persistence/sessionStore.js";

type RemovableSessionStore = SessionStore & {
  remove?: (sessionId: string) => Promise<boolean>;
};

test("lists sessions from newest to oldest creation time", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-agent-session-store-"));
  const filePath = path.join(directory, "sessions.json");
  await writeFile(
    filePath,
    JSON.stringify({
      sessions: [
        {
          sessionId: "older-created",
          threadId: null,
          summary: null,
          createdAt: "2026-07-10T08:00:00.000Z",
          updatedAt: "2026-07-14T08:00:00.000Z",
        },
        {
          sessionId: "newer-created",
          threadId: null,
          summary: null,
          createdAt: "2026-07-13T08:00:00.000Z",
          updatedAt: "2026-07-13T08:00:00.000Z",
        },
      ],
    }),
    "utf8",
  );

  try {
    const sessions = await new SessionStore(filePath).list();
    assert.deepEqual(
      sessions.map((session) => session.sessionId),
      ["newer-created", "older-created"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes a session from memory, persisted metadata, and token bindings", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-agent-session-store-"));
  const filePath = path.join(directory, "sessions.json");
  const store = new SessionStore(filePath) as RemovableSessionStore;
  await store.bindOaToken("delete-me", "secret-token", undefined, "19");

  try {
    assert.equal(typeof store.remove, "function");
    if (!store.remove) {
      return;
    }

    assert.equal(await store.remove("delete-me"), true);
    assert.equal(store.getOaToken("delete-me"), null);
    assert.equal(store.getOaUserId("delete-me"), null);
    assert.deepEqual(await store.list(), []);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { sessions: unknown[] };
    assert.deepEqual(persisted.sessions, []);
    assert.equal(await store.remove("delete-me"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the validated OA user id with the in-memory token binding", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-agent-session-store-"));
  const store = new SessionStore(path.join(directory, "sessions.json"));

  try {
    await store.bindOaToken("knowledge-session", "secret-token", undefined, "19");

    assert.equal(store.getOaUserId("knowledge-session"), "19");
    const persisted = await readFile(path.join(directory, "sessions.json"), "utf8");
    assert.doesNotMatch(persisted, /secret-token|\"19\"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("clears a stale OA user id when token validation cannot provide one", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-agent-session-store-"));
  const store = new SessionStore(path.join(directory, "sessions.json"));

  try {
    await store.bindOaToken("knowledge-session", "first-token", undefined, "19");
    await store.bindOaToken("knowledge-session", "second-token", undefined, null);

    assert.equal(store.getOaToken("knowledge-session"), "second-token");
    assert.equal(store.getOaUserId("knowledge-session"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scopes session listing and deletion to the validated OA user", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-agent-session-store-"));
  const filePath = path.join(directory, "sessions.json");
  const store = new SessionStore(filePath);
  const ownerA = createHash("sha256").update("user-a@example.test").digest("hex");
  const ownerB = createHash("sha256").update("user-b@example.test").digest("hex");

  try {
    await store.bindOaToken("user-a-session", "token-a", ownerA);
    await store.bindOaToken("user-b-session", "token-b", ownerB);

    assert.deepEqual(
      (await store.listForOwner(ownerA)).map((session) => session.sessionId),
      ["user-a-session"],
    );
    const persisted = await readFile(filePath, "utf8");
    assert.doesNotMatch(persisted, /token-a|token-b|user-a@example\.test|user-b@example\.test/);
    assert.equal(await store.removeForOwner("user-a-session", ownerB), false);
    assert.equal(await store.removeForOwner("user-a-session", ownerA), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists session ownership across restarts without persisting the OA token", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oa-agent-session-store-"));
  const filePath = path.join(directory, "sessions.json");
  const ownerA = createHash("sha256").update("user-a@example.test").digest("hex");
  const ownerB = createHash("sha256").update("user-b@example.test").digest("hex");

  try {
    const firstProcessStore = new SessionStore(filePath);
    assert.equal(
      await firstProcessStore.bindOaToken("owned-session", "raw-oa-token", ownerA),
      true,
    );

    const persisted = await readFile(filePath, "utf8");
    assert.match(persisted, new RegExp(ownerA));
    assert.doesNotMatch(persisted, /raw-oa-token|user-a@example\.test/);

    const restartedStore = new SessionStore(filePath);
    assert.deepEqual(
      (await restartedStore.listForOwner(ownerA)).map((session) => session.sessionId),
      ["owned-session"],
    );
    assert.equal(restartedStore.getOaToken("owned-session"), null);
    assert.equal(
      await restartedStore.bindOaToken("owned-session", "other-user-token", ownerB),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
