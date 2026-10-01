import { describe, expect, test } from "bun:test";
import { decode } from "../src/events";
import { NotificationPolicy, StateMachine, type Signal } from "../src/state";

const dir = "/project";
const session = "A";
function step(
  machine: StateMachine,
  signal: Signal,
  detail: string = signal,
  at = 1000,
  id?: string,
  sid = session,
) {
  return machine.apply(dir, sid, { signal, detail, requestID: id }, at);
}

describe("project state machine", () => {
  test("prompt, busy, tool, idle becomes done; duplicate idle does not re-stamp", () => {
    const m = new StateMachine();
    expect(step(m, "start", "prompt sent")?.state).toBe("working");
    expect(step(m, "activity", "busy")?.state).toBe("working");
    expect(step(m, "activity", "tool read")?.state).toBe("working");
    expect(step(m, "finish", "done — your move", 2000)?.state).toBe("done");
    expect(step(m, "finish", "done — your move", 2001)).toBeUndefined();
    expect(m.project.get(dir)?.since).toBe(2000);
    expect(step(m, "activity", "late tool")).toBeUndefined();
  });

  test("permission waiting resists busy and only matching reply resumes", () => {
    const m = new StateMachine();
    step(m, "start");
    step(m, "ask", "permission edit", 2000, "p1");
    expect(step(m, "activity", "busy")).toBeUndefined();
    expect(step(m, "approve", "approved", 3000, "p2")).toBeUndefined();
    expect(m.project.get(dir)?.state).toBe("waiting");
    expect(
      step(m, "approve", "permission approved — resuming", 3000, "p1")?.state,
    ).toBe("working");
  });

  test("question waiting survives unrelated activity; rejection is not approval", () => {
    const m = new StateMachine();
    step(m, "start");
    step(m, "ask", "question — input needed", 2000, "q");
    step(m, "activity", "reasoning");
    step(m, "activity", "shell");
    expect(m.project.get(dir)?.state).toBe("waiting");
    expect(step(m, "reject", "question rejected", 3000, "q")?.state).toBe(
      "error",
    );
  });

  test("multiple pending requests keep waiting until each relevant response", () => {
    const m = new StateMachine();
    step(m, "start");
    step(m, "ask", "permission edit", 2_000, "p");
    step(m, "ask", "question — input needed", 3_000, "q");
    expect(
      step(m, "approve", "permission approved — resuming", 4_000, "p"),
    ).toBeUndefined();
    expect(m.project.get(dir)?.state).toBe("waiting");
    expect(m.project.get(dir)?.detail).toBe("question — input needed");
    expect(
      step(m, "answer", "question answered — resuming", 5_000, "q")?.state,
    ).toBe("working");
  });

  test("failure and interruption persist across idle, clear on new prompt", () => {
    for (const signal of ["fail", "interrupt"] as const) {
      const m = new StateMachine();
      step(m, "start");
      step(m, signal, signal, 2000);
      expect(step(m, "finish", "done", 3000)).toBeUndefined();
      expect(m.project.get(dir)?.state).toBe("error");
      expect(step(m, "start", "prompt", 4000)?.state).toBe("working");
    }
  });

  test("done persists until a new prompt (ack belongs to manager)", () => {
    const m = new StateMachine();
    step(m, "start");
    step(m, "finish");
    expect(step(m, "activity", "busy")).toBeUndefined();
    expect(step(m, "start", "new prompt")?.state).toBe("working");
  });

  test("initial idle to busy records working entry time", () => {
    const m = new StateMachine();
    step(m, "created", "ready", 1_000);
    step(m, "activity", "busy", 2_000);
    expect(m.project.get(dir)?.since).toBe(2_000);
  });

  test("old session cannot finish new foreground session", () => {
    const m = new StateMachine();
    step(m, "start", "A");
    step(m, "start", "B", 2000, undefined, "B");
    expect(step(m, "finish", "done A", 3000)).toBeUndefined();
    expect(m.project.get(dir)?.detail).toBe("B");
    expect(m.activeSessionByDir.get(dir)).toBe("B");
  });
});

describe("notification eligibility", () => {
  test("duplicate completion suppresses a second notification", () => {
    const n = new NotificationPolicy();
    expect(n.eligible(dir, "done", "done", 1000)).toBe(true);
    n.record(dir, "done", "done", 1000);
    expect(n.eligible(dir, "done", "done", 1001)).toBe(false);
  });
  test("changed waiting detail uses 15s floor, same detail 120s; return re-notifies", () => {
    const n = new NotificationPolicy();
    expect(n.eligible(dir, "waiting", "first", 0)).toBe(true);
    n.record(dir, "waiting", "first", 0);
    expect(n.eligible(dir, "waiting", "first", 30_000)).toBe(false);
    expect(n.eligible(dir, "waiting", "second", 14_999)).toBe(false);
    expect(n.eligible(dir, "waiting", "second", 15_001)).toBe(true);
    n.record(dir, "waiting", "second", 15_001);
    n.eligible(dir, "working", "", 16_000);
    expect(n.eligible(dir, "waiting", "second", 16_001)).toBe(true);
  });
  test("failed delivery is retryable", () => {
    const n = new NotificationPolicy();
    expect(n.eligible(dir, "error", "failed", 0)).toBe(true);
    expect(n.eligible(dir, "error", "failed", 1)).toBe(true);
    expect(n.delivered.size).toBe(0);
  });
});

test("V2 payload semantics and legacy question compatibility", () => {
  expect(
    decode({
      type: "permission.replied",
      data: { sessionID: "A", requestID: "p", reply: "reject" },
    }).transition?.detail,
  ).toBe("permission denied");
  expect(
    decode({
      type: "form.created",
      data: { form: { id: "f", sessionID: "A", title: "Confirm" } },
    }).sessionID,
  ).toBe("A");
  expect(
    decode({ type: "form.cancelled", data: { sessionID: "A", id: "f" } })
      .transition?.signal,
  ).toBe("reject");
  expect(
    decode({ type: "question.rejected", data: { sessionID: "A" } }).transition
      ?.detail,
  ).toBe("question rejected");
  expect(
    decode({
      type: "question.asked",
      data: { sessionID: "A", questions: [{ header: "Which branch?" }] },
    }).transition?.detail,
  ).toBe("question — Which branch?");
  expect(
    decode({
      type: "session.execution.interrupted",
      data: { sessionID: "A", reason: "superseded" },
    }).transition,
  ).toBeUndefined();
  expect(
    decode({
      type: "session.status",
      data: { sessionID: "A", status: { type: "retry" } },
    }).transition,
  ).toBeUndefined();
});
