# opencode-tmux-session-status

[GitHub](https://github.com/4m1z/opencode-tmux-session-status) · [npm](https://www.npmjs.com/package/opencode-tmux-session-status)

OpenCode plugin that writes `@opencode_state`, `@opencode_state_at`, and
`@opencode_detail` to the owning tmux session for use by a picker or status
line. It also sends desktop notifications for `waiting`, `done`, and `error`.

Designed for [tmux-opencode-session-manager](https://github.com/4m1z/tmux-opencode-session-manager):
one session per project on the `opencode-popup` socket, named
`oc_<cksum-of-dir>` (`printf '%s' "$dir" | cksum`). The directory string must
match the launcher's cwd **exactly**; different spellings, trailing slashes,
symlinks, or worktrees produce different session names.

## Install

```sh
opencode plugin add opencode-tmux-session-status@latest
# Or from GitHub:
opencode plugin add github:4m1z/opencode-tmux-session-status
```

Alternatively, add it to `opencode.json` / `opencode.jsonc`:

```jsonc
{ "plugins": ["opencode-tmux-session-status@latest"] }
```

Requires `tmux` and `cksum` on `PATH`. Notifications use
`omarchy notification send`, falling back to `notify-send`. A missing tmux
session does not interrupt OpenCode.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "opencode-tmux-session-status@latest",
      "options": {
        "socket": "opencode-popup", // tmux server socket (-L)
        "prefix": "oc_", // before the directory hash
        "notifications": true,
        "notifier": "auto", // omarchy then notify-send; or "notify-send" only
        "notificationCooldownMs": 120000,
        "changedDetailFloorMs": 15000,
        "normalUrgency": "normal", // done
        "attentionUrgency": "critical", // waiting/error
        "notificationDetail": "full", // or "state" to hide details
        "debug": false,
      },
    },
  ],
}
```

## State model

| State     | Meaning                            |
| --------- | ---------------------------------- |
| `working` | Agent running                      |
| `waiting` | Permission or answer needed        |
| `done`    | Finished, awaiting acknowledgement |
| `error`   | Failed or interrupted              |
| `idle`    | Acknowledged, no outstanding work  |

Only the foreground run can update a project's state; queued prompts do not
take over until execution starts. `done` persists until the companion
manager's `ack.sh` changes it to `idle`; `error` persists until new work starts.
`@opencode_state_at` records when the state was entered, not a heartbeat.

## License

MIT
