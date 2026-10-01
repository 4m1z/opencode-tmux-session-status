import { spawn } from "node:child_process";

export type Failure =
  "unavailable" | "timeout" | "socket" | "session" | "other";
export type Result =
  { ok: true; output: string } | { ok: false; failure: Failure };

export function run(
  command: string,
  args: string[],
  timeout: number,
  signal: AbortSignal,
  input?: string,
): Promise<Result> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve({ ok: false, failure: "other" });
    let output = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: Result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout.on("data", (part: Buffer) => {
      output = (output + part.toString()).slice(0, 1024);
    });
    child.stderr.on("data", (part: Buffer) => {
      stderr = (stderr + part.toString()).slice(0, 1024);
    });
    child.on("error", (err: NodeJS.ErrnoException) =>
      finish({
        ok: false,
        failure: err.code === "ENOENT" ? "unavailable" : "other",
      }),
    );
    child.on("close", (code) => {
      if (timedOut) return finish({ ok: false, failure: "timeout" });
      if (code === 0) return finish({ ok: true, output });
      const failure =
        command === "tmux"
          ? /can't find session|no such session/i.test(stderr)
            ? "session"
            : /no server running|failed to connect|error connecting/i.test(
                  stderr,
                )
              ? "socket"
              : "other"
          : "other";
      finish({ ok: false, failure });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function clean(value: string, max: number): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/ +/g, " ")
    .slice(0, max);
}

export class Adapter {
  readonly sessions = new Map<string, string>();
  constructor(
    readonly socket: string,
    readonly prefix: string,
    readonly signal: AbortSignal,
    readonly diagnostic: (key: string, message: string) => void,
    readonly notifier: "auto" | "omarchy" | "notify-send" = "auto",
    readonly urgency: {
      normal: "low" | "normal" | "critical";
      attention: "low" | "normal" | "critical";
    } = { normal: "normal", attention: "critical" },
  ) {}

  async name(dir: string): Promise<string | undefined> {
    const cached = this.sessions.get(dir);
    if (cached) return cached;
    // Launcher: printf '%s' "$path" | cksum (no newline or canonicalization).
    const result = await run("cksum", [], 2000, this.signal, dir);
    const hash = result.ok
      ? /^([0-9]+)\s+[0-9]+(?:\s|$)/.exec(result.output)?.[1]
      : undefined;
    if (!hash) {
      this.diagnostic(
        "hash",
        `cksum ${result.ok ? "invalid output" : result.failure}`,
      );
      return;
    }
    const name = `${this.prefix}${hash}`;
    this.sessions.set(dir, name);
    return name;
  }

  async stamp(
    dir: string,
    state: string,
    since: number,
    detail: string,
    changedState: boolean,
  ): Promise<void> {
    const name = await this.name(dir);
    if (!name || this.signal.aborted) return;
    const args = [
      "-L",
      this.socket,
      "set-option",
      "-t",
      name,
      "@opencode_state",
      state,
    ];
    if (changedState)
      args.push(
        ";",
        "set-option",
        "-t",
        name,
        "@opencode_state_at",
        String(Math.floor(since / 1000)),
      );
    args.push(
      ";",
      "set-option",
      "-t",
      name,
      "@opencode_detail",
      clean(detail, 80),
    );
    const result = await run("tmux", args, 2000, this.signal);
    if (!result.ok && !this.signal.aborted)
      this.diagnostic(`tmux:${result.failure}`, `tmux ${result.failure}`);
  }

  async notify(
    dir: string,
    state: "done" | "waiting" | "error",
    detail: string,
  ): Promise<boolean> {
    const project = clean(
      dir.replace(/\/+$/, "").split("/").pop() || "opencode",
      60,
    );
    const title =
      state === "waiting"
        ? `opencode: input needed (${project})`
        : state === "error"
          ? `opencode: run failed (${project})`
          : `opencode: done (${project})`;
    const urgency =
      state === "done" ? this.urgency.normal : this.urgency.attention;
    const text = clean(detail, 120) || state;
    if (this.notifier !== "notify-send") {
      const first = await run(
        "omarchy",
        [
          "notification",
          "send",
          "--app-name",
          "opencode",
          "-u",
          urgency,
          title,
          text,
        ],
        3000,
        this.signal,
      );
      if (first.ok) return true;
      this.diagnostic("notify:omarchy", `omarchy ${first.failure}`);
    }
    if (this.signal.aborted) return false;
    const fallback = await run(
      "notify-send",
      ["-a", "opencode", "-u", urgency, title, text],
      3000,
      this.signal,
    );
    if (!fallback.ok)
      this.diagnostic("notify:notify-send", `notify-send ${fallback.failure}`);
    return fallback.ok;
  }
}
