export type State = "working" | "waiting" | "done" | "error" | "idle";
export type Signal =
  | "created"
  | "start"
  | "activity"
  | "ask"
  | "approve"
  | "deny"
  | "answer"
  | "reject"
  | "finish"
  | "fail"
  | "interrupt";

export interface Transition {
  signal: Signal;
  detail: string;
  requestID?: string;
}

export interface Snapshot {
  state: State;
  detail: string;
  since: number;
  pending?: Array<{
    kind: "permission" | "question";
    id?: string;
    detail: string;
  }>;
}

export function reduce(
  current: Snapshot | undefined,
  input: Transition,
  now: number,
): Snapshot | undefined {
  const { signal, detail } = input;
  if (signal === "created")
    return current ?? { state: "idle", detail, since: now };
  if (signal === "start")
    return {
      state: "working",
      detail,
      since: current?.state === "working" ? current.since : now,
    };
  if (signal === "activity") {
    if (
      current?.state === "waiting" ||
      current?.state === "error" ||
      current?.state === "done"
    )
      return;
    return {
      state: "working",
      detail,
      since: current?.state === "working" ? current.since : now,
    };
  }
  if (signal === "ask") {
    if (current?.state === "error" || current?.state === "done") return;
    const kind = detail.startsWith("permission") ? "permission" : "question";
    const pending = (current?.pending ?? []).filter(
      (request) => !input.requestID || request.id !== input.requestID,
    );
    return {
      state: "waiting",
      detail,
      since: current?.state === "waiting" ? current.since : now,
      pending: [...pending, { kind, id: input.requestID, detail }],
    };
  }
  if (
    signal === "approve" ||
    signal === "deny" ||
    signal === "answer" ||
    signal === "reject"
  ) {
    const kind =
      signal === "approve" || signal === "deny" ? "permission" : "question";
    if (current?.state !== "waiting") return;
    const requests = current.pending ?? [];
    const match = requests.findIndex(
      (request) =>
        request.kind === kind &&
        (!request.id || request.id === input.requestID),
    );
    if (match < 0) return;
    const pending = requests.filter((_, index) => index !== match);
    if (pending.length) {
      return {
        state: "waiting",
        detail: pending.at(-1)!.detail,
        since: current.since,
        pending,
      };
    }
    return {
      state: signal === "reject" ? "error" : "working",
      detail,
      since: now,
    };
  }
  if (signal === "fail" || signal === "interrupt") {
    if (current?.state === "done" || current?.state === "error") return;
    return { state: "error", detail, since: now };
  }
  if (signal === "finish") {
    if (current?.state !== "working") return;
    return { state: "done", detail, since: now };
  }
}

/** Exactly one foreground OpenCode session owns each project stamp. Only a
 * prompt/execution start can replace an existing owner. Other sessions' late
 * activity and terminal events are recorded only if they are already owner. */
export class StateMachine {
  readonly sessions = new Map<string, Snapshot>();
  readonly activeSessionByDir = new Map<string, string>();
  readonly project = new Map<string, Snapshot>();

  apply(
    dir: string,
    sessionID: string,
    input: Transition,
    now: number,
  ): Snapshot | undefined {
    const owner = this.activeSessionByDir.get(dir);
    if (owner && owner !== sessionID && input.signal !== "start") return;
    if (
      !owner &&
      input.signal !== "start" &&
      input.signal !== "ask" &&
      input.signal !== "activity" &&
      input.signal !== "created"
    )
      return;
    if (input.signal === "created" && this.project.has(dir)) return;
    const old = this.sessions.get(sessionID);
    const next = reduce(old, input, now);
    if (!next) return;
    this.sessions.set(sessionID, next);
    this.activeSessionByDir.set(dir, sessionID);
    const visible = this.project.get(dir);
    if (
      owner !== sessionID ||
      !visible ||
      next.state !== visible.state ||
      next.detail !== visible.detail
    ) {
      const result = {
        ...next,
        since: visible?.state === next.state ? visible.since : now,
      };
      this.project.set(dir, result);
      return result;
    }
  }
}

export interface NotificationRecord {
  state: State;
  detail: string;
  at: number;
}

export class NotificationPolicy {
  readonly delivered = new Map<string, NotificationRecord>();
  readonly previous = new Map<string, State>();
  constructor(
    readonly cooldown = 120_000,
    readonly changedDetailFloor = 15_000,
  ) {}
  eligible(dir: string, state: State, detail: string, now: number): boolean {
    const previous = this.previous.get(dir);
    this.previous.set(dir, state);
    if (state !== "waiting" && state !== "done" && state !== "error")
      return false;
    const last = this.delivered.get(dir);
    if (!last || previous !== state || last.state !== state) return true;
    return (
      now - last.at >=
      (last.detail === detail ? this.cooldown : this.changedDetailFloor)
    );
  }
  record(dir: string, state: State, detail: string, now: number): void {
    this.delivered.set(dir, { state, detail, at: now });
  }
}
