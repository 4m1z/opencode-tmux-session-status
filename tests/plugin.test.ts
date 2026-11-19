import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import plugin from "../src/index";
import { Adapter } from "../src/process";

const notifications: Array<{ directory: string; state: string }> = [];
const stamps: Array<{ directory: string; state: string }> = [];
const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  spyOn(Adapter.prototype, "notify").mockImplementation(
    async (directory, state) => {
      notifications.push({ directory, state });
      return true;
    },
  );
  spyOn(Adapter.prototype, "stamp").mockImplementation(
    async (directory, state) => {
      stamps.push({ directory, state });
    },
  );
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  notifications.length = 0;
  stamps.length = 0;
  mock.restore();
});

function event(type: string, directory?: string, sessionID = "session-a") {
  return {
    type,
    ...(directory ? { location: { directory } } : {}),
    data: { sessionID },
  };
}

async function start(
  directory: string,
  events: ReturnType<typeof event>[],
  sessionDirectory = "/project/a",
  parents: Record<string, string> = {},
) {
  const cleanup = await plugin.setup({
    location: { directory },
    options: {},
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        location: { directory: sessionDirectory },
        parentID: parents[sessionID],
      }),
      hook: async () => ({ dispose: async () => {} }),
    },
    tool: { hook: async () => ({ dispose: async () => {} }) },
    event: {
      subscribe: async function* () {
        yield* events;
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0]);
  if (cleanup) cleanups.push(cleanup);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("one completion notifies once across three loaded project instances", async () => {
  const events = [
    event("session.execution.started", "/project/a"),
    event("session.execution.succeeded", "/project/a"),
    event("session.idle", "/project/a"),
  ];
  for (const directory of ["/project/a", "/project/b", "/project/c"])
    await start(directory, events);

  expect(notifications).toEqual([{ directory: "/project/a", state: "done" }]);
  expect(stamps).toEqual([
    { directory: "/project/a", state: "working" },
    { directory: "/project/a", state: "done" },
  ]);
});

test("events without a location notify only the session's owning project", async () => {
  const events = [
    event("session.execution.started"),
    event("session.execution.succeeded"),
  ];
  await start("/project/a", events);
  await start("/project/b", events);

  expect(notifications).toEqual([{ directory: "/project/a", state: "done" }]);
});

test("each project still receives its own completion notification", async () => {
  const events = [
    event("session.execution.started", "/project/a"),
    event("session.execution.started", "/project/b", "session-b"),
    event("session.execution.succeeded", "/project/a"),
    event("session.execution.succeeded", "/project/b", "session-b"),
  ];
  await start("/project/a", events);
  await start("/project/b", events, "/project/b");

  expect(
    notifications.sort((a, b) => a.directory.localeCompare(b.directory)),
  ).toEqual([
    { directory: "/project/a", state: "done" },
    { directory: "/project/b", state: "done" },
  ]);
});

test("subagents do not announce completion or take over the main task's status", async () => {
  const events = [
    event("session.execution.started", "/project/a"),
    event("session.execution.started", "/project/a", "child-1"),
    event("session.execution.succeeded", "/project/a", "child-1"),
    event("session.execution.started", "/project/a", "child-2"),
    event("session.execution.succeeded", "/project/a", "child-2"),
    event("session.execution.succeeded", "/project/a"),
  ];
  await start("/project/a", events, "/project/a", {
    "child-1": "session-a",
    "child-2": "session-a",
  });

  expect(notifications).toEqual([{ directory: "/project/a", state: "done" }]);
  expect(stamps).toEqual([
    { directory: "/project/a", state: "working" },
    { directory: "/project/a", state: "done" },
  ]);
});

test("subagent permission requests still alert and resume the main task", async () => {
  const events = [
    event("session.execution.started", "/project/a"),
    event("session.execution.started", "/project/a", "child-1"),
    {
      ...event("permission.asked", "/project/a", "child-1"),
      data: { sessionID: "child-1", id: "request-1", action: "shell" },
    },
    {
      ...event("permission.replied", "/project/a", "child-1"),
      data: { sessionID: "child-1", requestID: "request-1", reply: "once" },
    },
    event("session.execution.succeeded", "/project/a", "child-1"),
    event("session.execution.succeeded", "/project/a"),
  ];
  await start("/project/a", events, "/project/a", { "child-1": "session-a" });

  expect(notifications).toEqual([
    { directory: "/project/a", state: "waiting" },
    { directory: "/project/a", state: "done" },
  ]);
  expect(stamps).toEqual([
    { directory: "/project/a", state: "working" },
    { directory: "/project/a", state: "waiting" },
    { directory: "/project/a", state: "working" },
    { directory: "/project/a", state: "done" },
  ]);
});

test("a parent pause does not announce completion while its child still needs input", async () => {
  const events = [
    event("session.execution.started", "/project/a"),
    event("session.execution.started", "/project/a", "child-1"),
    event("session.step.failed", "/project/a", "child-1"),
    event("session.execution.succeeded", "/project/a"),
    {
      ...event("permission.asked", "/project/a", "child-1"),
      data: { sessionID: "child-1", id: "request-1", action: "shell" },
    },
    {
      ...event("permission.replied", "/project/a", "child-1"),
      data: { sessionID: "child-1", requestID: "request-1", reply: "once" },
    },
    event("session.execution.succeeded", "/project/a", "child-1"),
    event("session.execution.started", "/project/a"),
    event("session.execution.succeeded", "/project/a"),
  ];
  await start("/project/a", events, "/project/a", { "child-1": "session-a" });

  expect(notifications).toEqual([
    { directory: "/project/a", state: "waiting" },
    { directory: "/project/a", state: "done" },
  ]);
});

test("canceling a child question does not mark a successful main task as failed", async () => {
  const events = [
    event("session.execution.started", "/project/a"),
    event("session.execution.started", "/project/a", "child-1"),
    {
      ...event("form.created", "/project/a", "child-1"),
      data: {
        sessionID: "child-1",
        form: { id: "form-1", sessionID: "child-1", title: "Choose an option" },
      },
    },
    {
      ...event("form.cancelled", "/project/a", "child-1"),
      data: { sessionID: "child-1", id: "form-1" },
    },
    event("session.execution.failed", "/project/a", "child-1"),
    event("session.execution.succeeded", "/project/a"),
  ];
  await start("/project/a", events, "/project/a", { "child-1": "session-a" });

  expect(notifications).toEqual([
    { directory: "/project/a", state: "waiting" },
    { directory: "/project/a", state: "done" },
  ]);
  expect(stamps.at(-1)).toEqual({ directory: "/project/a", state: "done" });
});
