import type { Transition } from "./state";

type RecordValue = Record<string, unknown>;
const obj = (v: unknown): RecordValue =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as RecordValue)
    : {};
export const nonempty = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v : undefined;
const field = (v: unknown, key: string) => obj(v)[key];
const text = (v: unknown): string | undefined =>
  nonempty(v) ?? nonempty(field(v, "message"));

export interface Decoded {
  sessionID?: string;
  directory?: string;
  transition?: Transition;
  type?: string;
}

/** V2 events use {type,location,data}; question.* is a narrow compatibility
 * path for servers which emitted those events before form.* was introduced. */
export function decode(raw: unknown): Decoded {
  const envelope = obj(raw);
  // Earlier service builds emitted {directory,payload:{type,properties}};
  // the installed V2 stream emits {type,location,data} directly.
  const event = nonempty(field(envelope.payload, "type"))
    ? obj(envelope.payload)
    : envelope;
  const type = nonempty(event.type);
  if (!type) return {};
  const data = obj(event.data ?? event.properties);
  const directory =
    nonempty(field(event.location, "directory")) ??
    nonempty(envelope.directory) ??
    (type === "session.created"
      ? nonempty(field(data.location, "directory"))
      : undefined);
  const sessionID =
    nonempty(data.sessionID) ??
    nonempty(event.sessionID) ??
    nonempty(envelope.sessionID);
  const base = { type, directory, sessionID };
  const signal = (
    signal: Transition["signal"],
    detail: string,
    requestID?: string,
  ): Decoded => ({ ...base, transition: { signal, detail, requestID } });
  switch (type) {
    case "session.created":
      return signal("created", "ready");
    case "session.execution.started":
      return signal("start", "working");
    case "session.execution.succeeded":
    case "session.idle":
      return signal("finish", "done — your move");
    case "session.execution.failed":
    case "session.step.failed":
    case "session.next.step.failed":
    case "session.error":
      return signal("fail", text(data.error) || "run failed");
    case "session.execution.interrupted":
      if (data.reason === "superseded") return base;
      return signal(
        "interrupt",
        `interrupted${nonempty(data.reason) ? ` — ${data.reason}` : ""}`,
      );
    case "session.status": {
      const status = field(data.status, "type");
      if (status === "idle") return signal("finish", "done — your move");
      if (status === "busy") return signal("activity", "working");
      return base;
    }
    case "permission.asked":
      return signal(
        "ask",
        `permission ${nonempty(data.action) || "approval needed"}`,
        nonempty(data.id),
      );
    case "permission.replied":
      return data.reply === "reject"
        ? signal("deny", "permission denied", nonempty(data.requestID))
        : data.reply === "once" || data.reply === "always"
          ? signal(
              "approve",
              "permission approved — resuming",
              nonempty(data.requestID),
            )
          : base;
    case "form.created": {
      const form = obj(data.form);
      return {
        ...signal(
          "ask",
          nonempty(form.title) || "question — input needed",
          nonempty(form.id),
        ),
        sessionID: nonempty(form.sessionID),
      };
    }
    case "form.replied":
      return signal(
        "answer",
        "question answered — resuming",
        nonempty(data.id),
      );
    case "form.cancelled":
      return signal("reject", "question cancelled", nonempty(data.id));
    case "question.asked": {
      const first = Array.isArray(data.questions)
        ? data.questions[0]
        : undefined;
      const label =
        nonempty(field(first, "header")) ??
        nonempty(field(first, "question")) ??
        "input needed";
      return signal("ask", `question — ${label}`, nonempty(data.id));
    }
    case "question.replied":
      return signal(
        "answer",
        "question answered — resuming",
        nonempty(data.requestID) ?? nonempty(data.id),
      );
    case "question.rejected":
      return signal(
        "reject",
        "question rejected",
        nonempty(data.requestID) ?? nonempty(data.id),
      );
    case "session.step.started":
      return signal(
        "activity",
        `step${nonempty(data.agent) ? ` ${data.agent}` : ""}`,
      );
    case "session.next.step.started":
      return signal(
        "activity",
        `step${nonempty(data.agent) ? ` ${data.agent}` : ""}`,
      );
    case "session.prompted":
    case "session.next.prompted":
      return signal("start", "prompt sent");
    case "command.executed":
      return signal("start", "command sent");
    case "session.tool.called":
    case "session.next.tool.called":
    case "session.text.started":
    case "session.next.text.started":
    case "session.reasoning.started":
    case "session.next.reasoning.started":
    case "session.shell.started":
    case "session.next.shell.started":
    case "session.compaction.started":
      return signal("activity", nonempty(data.name) || "working");
    default:
      return base;
  }
}
