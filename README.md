# opencode-tmux-session-status

[GitHub](https://github.com/4m1z/opencode-tmux-session-status) · [npm](https://www.npmjs.com/package/opencode-tmux-session-status)

OpenCode server plugin that stamps the owning tmux session with
`@opencode_state` / `@opencode_state_at` / `@opencode_detail`, so a picker or
status-line can show whether each session is `working` / `waiting` / `done` /
`error` / `idle` without scraping pane contents. Terminal states (`done` /
`waiting` / `error`) also fire a desktop notification (via `omarchy`,
falling back to `notify-send`).

Built for the tmux-opencode-session-manager layout: one tmux session per
project directory on a dedicated tmux server socket (default
`opencode-popup`), named `oc_<cksum-of-dir>` (same hash as
`scripts/helpers.sh session_hash`: `printf '%s' "$dir" | cksum`). The scripts
live in the companion `tmux-opencode-session-manager` repository. The hash
uses the **exact directory string** from the launcher's resolved cwd (or `$PWD`
fallback), with no trimming, symlink resolution, or canonicalization. Configure
OpenCode with that same location; a different spelling, trailing slash, or
worktree directory intentionally hashes to a different tmux session.

## Install

**From npm:**

```sh
opencode plugin add opencode-tmux-session-status@latest
```

**From git or local checkout:**

```sh
opencode plugin add github:4m1z/opencode-tmux-session-status
# or pin a ref:
opencode plugin add github:4m1z/opencode-tmux-session-status#main
```

Or declare it in config (`opencode.json` / `opencode.jsonc`):

```jsonc
{
  "plugins": ["opencode-tmux-session-status@latest"],
  // "plugins": ["opencode-tmux-session-status@0.1.1"]
  // "plugins": ["github:4m1z/opencode-tmux-session-status"]
  // "plugins": ["./path/to/opencode-tmux-session-status"] // no build needed, loads from src/
}
```

Requires `tmux` and `cksum` on `PATH`. Notifications are best-effort:
`omarchy notification send`, falling back to `notify-send`. Missing
socket/session never breaks the run; the picker falls back to the API.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "opencode-tmux-session-status@latest",
      "options": {
        "socket": "opencode-popup", // tmux server socket (-L)
        "prefix": "oc_", // session name prefix before the cksum hash
        "notifications": true,
        "notifier": "auto", // auto/omarchy: omarchy then notify-send; notify-send: only notify-send
        "notificationCooldownMs": 120000,
        "changedDetailFloorMs": 15000,
        "normalUrgency": "normal", // done
        "attentionUrgency": "critical", // waiting/error
        "notificationDetail": "full", // "state" hides question/error details on desktop
        "debug": false,
      },
    },
  ],
}
```

## State model

| State     | Meaning                                                     |
| --------- | ----------------------------------------------------------- |
| `working` | agent is actively running                                   |
| `waiting` | needs input: permission request or open question            |
| `done`    | turn finished, unacknowledged (stays until ack on open)     |
| `error`   | run failed / session errored (stays until next task starts) |
| `idle`    | no work outstanding, acknowledged                           |

Completion is never inferred from silence; only explicit idle/error events
produce `done` / `error`.

The project stamp belongs to one **foreground session ID** at a time: a new
prompt or execution start can take ownership; old sessions' completion events
cannot finish the new one. Queued prompts wait for execution to start. A
permission or form request locks that run in `waiting` until its matching
reply/cancellation. Approval/answer resumes `working`; denial reports
`permission denied` as working without claiming approval, while question
rejection/cancellation shows `error`. Interruption shows `error` rather than a
successful completion; a `superseded` interruption is ignored because the new
run supplies its own start event. Failed runs ignore later idle/completion events until
new work starts; completed runs ignore ordinary busy/tool events until new
work starts. `ack.sh` owns the `done → idle` transition. The plugin only
updates `@opencode_state_at` on a state change, as the status line, picker and
reconciler interpret it as **time entered**, not a heartbeat.

OpenCode 2.0.21's shared `ctx.event.subscribe({ signal })` stream carries
`{ type, location, data }` events. Earlier `question.*`, `session.next.*`, and
`{ directory, payload: { type, properties } }` envelopes remain supported.
Unlocated events resolve through the session ID cache or
`ctx.session.get({ sessionID })`; an unresolvable event is ignored. When `debug`
is enabled, concise failure/ignored-event diagnostics are rate-limited to once
per minute per category. Notification and tmux failures do not interrupt the
OpenCode run.

## License

MIT
