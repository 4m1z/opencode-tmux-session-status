import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { Adapter, clean } from "./process";
import { decode, nonempty, type Decoded } from "./events";
import { NotificationPolicy, StateMachine, type Transition } from "./state";

type SessionLookup = Pick<Context["session"], "get">;

export async function resolveDirectory(
  event: Decoded,
  cache: Map<string, string>,
  session: SessionLookup,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const explicit = nonempty(event.directory);
  if (explicit) {
    if (event.sessionID) cache.set(event.sessionID, explicit);
    return explicit;
  }
  if (!event.sessionID) return;
  const cached = cache.get(event.sessionID);
  if (cached) return cached;
  try {
    const info = await session.get({ sessionID: event.sessionID }, { signal });
    const dir = nonempty(info.location.directory);
    if (dir) cache.set(event.sessionID, dir);
    return dir;
  } catch {
    return;
  }
}

export default Plugin.define({
  id: "tmux-status",
  async setup(ctx) {
    const o = ctx.options;
    const socket = nonempty(o.socket) || "opencode-popup";
    const prefix = nonempty(o.prefix) || "oc_";
    const controller = new AbortController();
    const debug = o.debug === true;
    const debugAt = new Map<string, number>();
    const diagnostic = (key: string, message: string) => {
      if (
        !debug ||
        controller.signal.aborted ||
        Date.now() - (debugAt.get(key) ?? -Infinity) < 60_000
      )
        return;
      debugAt.set(key, Date.now());
      console.error(`[tmux-status] ${message}`);
    };
    const adapter = new Adapter(
      socket,
      prefix,
      controller.signal,
      diagnostic,
      o.notifier === "notify-send" || o.notifier === "omarchy"
        ? o.notifier
        : "auto",
      {
        normal:
          o.normalUrgency === "low" || o.normalUrgency === "critical"
            ? o.normalUrgency
            : "normal",
        attention:
          o.attentionUrgency === "low" || o.attentionUrgency === "normal"
            ? o.attentionUrgency
            : "critical",
      },
    );
    const machine = new StateMachine();
    const notifications = new NotificationPolicy(
      typeof o.notificationCooldownMs === "number" &&
        Number.isFinite(o.notificationCooldownMs) &&
        o.notificationCooldownMs >= 0
        ? o.notificationCooldownMs
        : 120_000,
      typeof o.changedDetailFloorMs === "number" &&
        Number.isFinite(o.changedDetailFloorMs) &&
        o.changedDetailFloorMs >= 0
        ? o.changedDetailFloorMs
        : 15_000,
    );
    const directories = new Map<string, string>();
    let queue: Promise<void> = Promise.resolve();

    const enqueue = (event: Decoded) => {
      // Both hooks and the one subscription enter the same FIFO before any
      // directory lookup, hash or subprocess can yield and reorder them.
      queue = queue
        .then(async () => {
          if (controller.signal.aborted) return;
          if (!event.transition || !event.sessionID) {
            diagnostic(
              "malformed",
              `ignored malformed ${event.type || "event"}`,
            );
            return;
          }
          const dir = await resolveDirectory(
            event,
            directories,
            ctx.session,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if (!dir) {
            diagnostic("directory", "unresolved session directory");
            return;
          }
          const before = machine.project.get(dir);
          const next = machine.apply(
            dir,
            event.sessionID,
            event.transition,
            Date.now(),
          );
          if (!next) {
            diagnostic(
              "transition",
              `ignored stale/invalid ${event.type || "event"}`,
            );
            return;
          }
          const detail = clean(next.detail, 120);
          await adapter.stamp(
            dir,
            next.state,
            next.since,
            detail,
            before?.state !== next.state,
          );
          if (controller.signal.aborted || o.notifications === false) return;
          if (!notifications.eligible(dir, next.state, detail, Date.now()))
            return;
          if (
            next.state !== "waiting" &&
            next.state !== "done" &&
            next.state !== "error"
          )
            return;
          if (
            await adapter.notify(
              dir,
              next.state,
              o.notificationDetail === "state" ? next.state : detail,
            )
          )
            notifications.record(dir, next.state, detail, Date.now());
        })
        .catch(() => diagnostic("event", "state update failed"));
    };

    const hookTransition = (sessionID: string, transition: Transition) =>
      enqueue({ sessionID, transition, type: `hook.${transition.signal}` });
    const registrations: Array<{ dispose(): Promise<void> }> = [];
    try {
      registrations.push(
        await ctx.session.hook("prompt", (event) => {
          // Queue admission does not mean the agent has started executing.
          if (event.delivery !== "queue")
            hookTransition(event.sessionID, {
              signal: "start",
              detail: "prompt sent",
            });
        }),
      );
      registrations.push(
        await ctx.tool.hook("execute.before", (event) => {
          hookTransition(event.sessionID, {
            signal: "activity",
            detail: `tool ${event.tool}`,
          });
        }),
      );
    } catch {
      diagnostic("hooks", "hook registration failed");
    }
    const subscription = (async () => {
      try {
        for await (const raw of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          const event = decode(raw);
          if (event.transition) enqueue(event);
        }
      } catch {
        if (!controller.signal.aborted)
          diagnostic("subscription", "event subscription failed");
      }
    })();

    return async () => {
      controller.abort();
      await Promise.allSettled(
        registrations.map((registration) => registration.dispose()),
      );
      await subscription;
      await queue;
    };
  },
});
