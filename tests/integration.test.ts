import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Adapter, run } from "../src/process";
import plugin, { resolveDirectory } from "../src/index";
import {
  NotificationPolicy,
  StateMachine,
  type Transition,
} from "../src/state";

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0))
    await rm(dir, { recursive: true, force: true });
});

test("unresolvable global event never uses plugin instance directory", async () => {
  const cache = new Map<string, string>();
  const session = {
    get: async () => {
      throw Error("not found");
    },
  };
  expect(
    await resolveDirectory(
      { sessionID: "missing", type: "session.idle" },
      cache,
      session,
    ),
  ).toBeUndefined();
  expect(
    await resolveDirectory({ type: "session.idle" }, cache, session),
  ).toBeUndefined();
  expect(
    await resolveDirectory({ sessionID: "A", directory: "/a" }, cache, session),
  ).toBe("/a");
  expect(await resolveDirectory({ sessionID: "A" }, cache, session)).toBe("/a");
});

test("notifiers: fallback success recorded once; both failures remain retryable", async () => {
  const dir = await mkdtemp("/tmp/opencode/oc-notify-");
  temporary.push(dir);
  const oldPath = process.env.PATH;
  try {
    for (const [file, exit] of [
      ["omarchy", "exit 1"],
      ["notify-send", "exit 0"],
    ])
      await writeFile(
        join(dir, file),
        `#!/bin/sh\nprintf '%s\\n' '${file}' >> '${dir}/calls'\n${exit}\n`,
        { mode: 0o755 },
      );
    process.env.PATH = `${dir}:${oldPath}`;
    const adapter = new Adapter(
      "unused",
      "oc_",
      new AbortController().signal,
      () => {},
    );
    expect(await adapter.notify("/project", "waiting", "input needed")).toBe(
      true,
    );
    expect(
      (await Bun.file(join(dir, "calls")).text()).trim().split("\n"),
    ).toEqual(["omarchy", "notify-send"]);
    await writeFile(join(dir, "notify-send"), `#!/bin/sh\nexit 1\n`, {
      mode: 0o755,
    });
    expect(await adapter.notify("/project", "waiting", "input needed")).toBe(
      false,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("cksum matches launcher bytes, cached; tmux stamps atomically with state-entry timestamp", async () => {
  const dir = await mkdtemp("/tmp/opencode/oc-tmux-");
  temporary.push(dir);
  const socket = `oc-test-${process.pid}-${Date.now()}`;
  const controller = new AbortController();
  const adapter = new Adapter(socket, "oc_", controller.signal, () => {});
  const project = "/tmp/test project/";
  const hash = execFileSync("cksum", {
    input: project,
    encoding: "utf8",
  }).split(" ")[0];
  const name = `oc_${hash}`;
  try {
    execFileSync("tmux", ["-L", socket, "new-session", "-d", "-s", name]);
    expect(await adapter.name(project)).toBe(name);
    expect(adapter.sessions.size).toBe(1);
    await adapter.stamp(project, "working", 100_000, "tool\nread", true);
    await adapter.stamp(project, "working", 200_000, "tool write", false);
    const get = (option: string) =>
      execFileSync(
        "tmux",
        ["-L", socket, "show-options", "-qv", "-t", name, option],
        { encoding: "utf8" },
      ).trim();
    expect(get("@opencode_state")).toBe("working");
    expect(get("@opencode_state_at")).toBe("100");
    expect(get("@opencode_detail")).toBe("tool write");
    await adapter.stamp(project, "done", 300_000, "done", true);
    expect(get("@opencode_state_at")).toBe("300");
  } finally {
    controller.abort();
    execFileSync("tmux", ["-L", socket, "kill-server"]);
  }
});

test("missing tmux session/socket and executable report distinct nonfatal results", async () => {
  const signal = new AbortController().signal;
  expect((await run("no-such-oc-command", [], 100, signal)).ok).toBe(false);
  const socket = `oc-missing-${process.pid}-${Date.now()}`;
  expect(
    await run(
      "tmux",
      ["-L", socket, "show-options", "-t", "=missing"],
      1000,
      signal,
    ),
  ).toMatchObject({ ok: false, failure: "socket" });
  expect(await run("sleep", ["1"], 10, signal)).toMatchObject({
    ok: false,
    failure: "timeout",
  });
});

test("real tmux lifecycle, acknowledgement, error persistence and notification dedupe", async () => {
  const temp = await mkdtemp("/tmp/opencode/oc-lifecycle-");
  temporary.push(temp);
  const socket = `oc-lifecycle-${process.pid}-${Date.now()}`;
  const project = temp;
  const hash = execFileSync("cksum", {
    input: project,
    encoding: "utf8",
  }).split(" ")[0];
  const name = `oc_${hash}`;
  const oldPath = process.env.PATH;
  const controller = new AbortController();
  const machine = new StateMachine();
  const policy = new NotificationPolicy();
  try {
    execFileSync("tmux", ["-L", socket, "new-session", "-d", "-s", name]);
    await writeFile(
      join(temp, "omarchy"),
      `#!/bin/sh\nprintf 'notification\\n' >> '${temp}/notifications'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${temp}:${oldPath}`;
    const adapter = new Adapter(socket, "oc_", controller.signal, () => {});
    const get = (option: string) =>
      execFileSync(
        "tmux",
        ["-L", socket, "show-options", "-qv", "-t", name, option],
        { encoding: "utf8" },
      ).trim();
    const apply = async (transition: Transition, at: number) => {
      const previous = machine.project.get(project);
      const next = machine.apply(project, "A", transition, at);
      if (!next) return;
      await adapter.stamp(
        project,
        next.state,
        next.since,
        next.detail,
        previous?.state !== next.state,
      );
      if (
        policy.eligible(project, next.state, next.detail, at) &&
        (next.state === "waiting" ||
          next.state === "done" ||
          next.state === "error") &&
        (await adapter.notify(project, next.state, next.detail))
      )
        policy.record(project, next.state, next.detail, at);
    };
    await apply({ signal: "created", detail: "ready" }, 1_000);
    expect(get("@opencode_state")).toBe("idle");
    await apply({ signal: "start", detail: "prompt sent" }, 2_000);
    expect(get("@opencode_state")).toBe("working");
    await apply({ signal: "activity", detail: "tool read" }, 3_000);
    expect(get("@opencode_detail")).toBe("tool read");
    expect(get("@opencode_state_at")).toBe("2");
    await apply(
      { signal: "ask", detail: "permission edit", requestID: "p" },
      4_000,
    );
    expect(get("@opencode_state")).toBe("waiting");
    await apply({ signal: "activity", detail: "busy" }, 5_000);
    expect(get("@opencode_state")).toBe("waiting");
    await apply(
      {
        signal: "approve",
        detail: "permission approved — resuming",
        requestID: "p",
      },
      6_000,
    );
    expect(get("@opencode_state")).toBe("working");
    await apply({ signal: "finish", detail: "done — your move" }, 7_000);
    await apply({ signal: "finish", detail: "done — your move" }, 7_001);
    expect(get("@opencode_state")).toBe("done");
    expect(
      (await Bun.file(join(temp, "notifications")).text()).trim().split("\n"),
    ).toHaveLength(2);
    // ack.sh on open: only done -> idle; the plugin starts a new turn later.
    execFileSync("tmux", [
      "-L",
      socket,
      "set-option",
      "-t",
      name,
      "@opencode_state",
      "idle",
    ]);
    expect(get("@opencode_state")).toBe("idle");
    await apply({ signal: "start", detail: "new prompt" }, 8_000);
    await apply({ signal: "fail", detail: "run failed" }, 9_000);
    await apply({ signal: "finish", detail: "done — your move" }, 10_000);
    expect(get("@opencode_state")).toBe("error");
    expect(
      (await Bun.file(join(temp, "notifications")).text()).trim().split("\n"),
    ).toHaveLength(3);
  } finally {
    process.env.PATH = oldPath;
    controller.abort();
    execFileSync("tmux", ["-L", socket, "kill-server"]);
  }
});

test("hook lookup and stream events stay ordered; cleanup aborts stream and disposes hooks", async () => {
  const socket = `oc-queue-${process.pid}-${Date.now()}`;
  const project = "/tmp/opencode/queue-project";
  const hash = execFileSync("cksum", {
    input: project,
    encoding: "utf8",
  }).split(" ")[0];
  const name = `oc_${hash}`;
  let release!: (value: { location: { directory: string } }) => void;
  const lookup = new Promise<{ location: { directory: string } }>((resolve) => {
    release = resolve;
  });
  const callbacks = new Map<
    string,
    (event: { sessionID: string; delivery?: string }) => void
  >();
  let disposeCount = 0;
  let send!: (event: unknown) => void;
  let stopped = false;
  const stream = (signal: AbortSignal): AsyncIterable<unknown> => ({
    async *[Symbol.asyncIterator]() {
      while (!signal.aborted) {
        const item = await new Promise<unknown>((resolve) => {
          send = resolve;
          signal.addEventListener("abort", () => resolve(undefined), {
            once: true,
          });
        });
        if (signal.aborted) break;
        yield item;
      }
      stopped = true;
    },
  });
  const ctx = {
    options: { socket, notifications: false },
    session: {
      get: async () => lookup,
      hook: async (
        name: string,
        cb: (event: { sessionID: string; delivery?: string }) => void,
      ) => {
        callbacks.set(name, cb);
        return {
          dispose: async () => {
            disposeCount++;
          },
        };
      },
    },
    tool: {
      hook: async (
        name: string,
        cb: (event: { sessionID: string }) => void,
      ) => {
        callbacks.set(name, cb);
        return {
          dispose: async () => {
            disposeCount++;
          },
        };
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => stream(signal),
    },
    location: { directory: "/wrong-project" },
  } as unknown as Parameters<typeof plugin.setup>[0];
  execFileSync("tmux", ["-L", socket, "new-session", "-d", "-s", name]);
  try {
    const cleanup = await plugin.setup(ctx);
    expect(cleanup).toBeFunction();
    callbacks.get("prompt")?.({ sessionID: "A", delivery: "steer" });
    await Bun.sleep(10);
    send({
      type: "session.idle",
      location: { directory: project },
      data: { sessionID: "A" },
    });
    release({ location: { directory: project } });
    const get = () =>
      execFileSync(
        "tmux",
        ["-L", socket, "show-options", "-qv", "-t", name, "@opencode_state"],
        { encoding: "utf8" },
      ).trim();
    for (let attempt = 0; attempt < 100 && get() !== "done"; attempt++)
      await Bun.sleep(10);
    expect(get()).toBe("done");
    if (cleanup) await cleanup();
    expect(stopped).toBe(true);
    expect(disposeCount).toBe(2);
  } finally {
    execFileSync("tmux", ["-L", socket, "kill-server"]);
  }
});
