# opencode-tmux-status

Opencode server plugin that stamps the owning tmux session with
`@opencode_state` / `@opencode_state_at` / `@opencode_detail`, so a picker or
status-line can show whether each session is `working` / `waiting` / `done` /
`error` / `idle` without scraping pane contents. Terminal states (`done` /
`waiting` / `error`) also fire a desktop notification (via `omarchy`,
falling back to `notify-send`).

Built for the tmux-opencode-session-manager layout: one tmux session per
project directory on a dedicated tmux server socket (default
`opencode-popup`), named `oc_<cksum-of-dir>` (same hash as
`scripts/helpers.sh session_hash`: `printf '%s' "$dir" | cksum`).

## Install

**From npm:**

```sh
opencode plugin add opencode-tmux-status@latest
```

**From git or local checkout:**

```sh
opencode plugin add github:4m1z/opencode-tmux-status
# or pin a ref:
opencode plugin add github:4m1z/opencode-tmux-status#main
```

Or declare it in config (`opencode.json` / `opencode.jsonc`):

```jsonc
{
  "plugins": ["opencode-tmux-status@latest"]
  // "plugins": ["opencode-tmux-status@0.1.0"]
  // "plugins": ["github:4m1z/opencode-tmux-status"]
  // "plugins": ["./path/to/opencode-tmux-status"] // no build needed, loads from src/
}
```

Requires `tmux` and `cksum` on `PATH`. Notifications are best-effort:
`omarchy notification send`, falling back to `notify-send`. Missing
socket/session never breaks the run — the picker falls back to the API.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "opencode-tmux-status@latest",
      "options": {
        "socket": "opencode-popup", // tmux server socket (-L)
        "prefix": "oc_", // session name prefix before the cksum hash
      },
    },
  ],
}
```

## State model

| State | Meaning |
| --- | --- |
| `working` | agent is actively running |
| `waiting` | needs input: permission request or open question |
| `done` | turn finished, unacknowledged (stays until ack on open) |
| `error` | run failed / session errored (stays until next task starts) |
| `idle` | no work outstanding, acknowledged |

Completion is never inferred from silence — only explicit idle/error events
produce `done` / `error`.

## License

MIT
