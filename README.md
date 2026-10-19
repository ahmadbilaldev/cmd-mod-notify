# Notify

A desktop notification and a sound when the agent needs you, so you can look away while it
works.

| Event | Default | Fires when |
|---|---|---|
| `complete` | on | a run finishes (also when it stops at the turn limit or after a declined permission) |
| `failed` | on | a run ends with an error |
| `permission` | on | a permission prompt is about to wait for you |
| `question` | on | the agent asks you a question |
| `session_end` | off | the session ends |

A run you interrupt stays quiet: you are already there.

**Reminders.** A permission prompt or a question that stays unanswered is sent again every two
minutes, up to three times. The reminders stop as soon as anything moves: you answer, a new turn
starts, the run ends.

**Native notifications** use the platform's own tool: `osascript` on macOS, `notify-send` on
Linux, a PowerShell toast on Windows. A missing tool is skipped silently. To use something else
(`terminal-notifier`, a script that pushes to your phone), set a command; it runs with the title
and the message as its two arguments.

**Sounds** are the two WAV files in `sounds/`: a chime when work is done, an alert when you are
needed. Where no audio player exists, the terminal bell rings instead. The desktop app does not
play mod sounds yet.

## Commands

```
/notify                            show the settings
/notify test                       send a test notification
/notify <event> on|off             complete, failed, permission, question, session_end
/notify sound on|off
/notify native on|off
/notify recap on|off               summarize the reply in the "done" notification
/notify command <cmd> | default    run your own notifier
```

Settings are kept across sessions. `recap` is off by default: it asks the session model for a
one-line summary of the final reply, one short extra model call per run.

## Tool

`notify_user({title?, message, priority?})` lets the model send a notification itself, for
example when long work you are waiting on finishes. `priority: "high"` plays the alert sound.

## Not included

- Gotify, Telegram, and ntfy channels: notifications are local to this machine (point
  `/notify command` at your own relay script to reach other devices).
- Skipping notifications while the terminal window is focused.
- Quiet periods after you type.
