# notes CLI

| Command                          | Effect                        |
| -------------------------------- | ----------------------------- |
| `notes list`                     | List notebooks                |
| `notes create <notebook>`        | Create an empty notebook      |
| `notes add <notebook> <text...>` | Append one note               |
| `notes show <notebook>`          | Print notes with line numbers |
| `notes remove <notebook> <n>`    | Delete note number `n`        |

Exit codes: 0 success, 1 missing or duplicate notebook, 2 bad arguments, 3 `NOTES_TOKEN` not set.

Notebooks are plain text files in `~/notebooks`, one note per line, and persist across restarts.
