# Eval task: incremental multi-file build

You are building a small but non-trivial command-line tool from scratch. Work
through every numbered task in order. Do not stop until all tasks are done or
you are blocked; if blocked, state the blocker explicitly and continue with the
next independent task.

Build a `todo` CLI in a single language of your choice with these features:

1. `add <text>` — append a todo item to a local store (a JSON file).
2. `list` — print all items with a 1-based index and a done/undone marker.
3. `done <index>` — mark an item complete.
4. `rm <index>` — remove an item.
5. `clear` — remove all completed items.
6. Persist the store between invocations; create it on first use.
7. Handle bad input gracefully (out-of-range index, missing args, corrupt store)
   with clear error messages and non-zero exit codes.
8. Add a `--json` flag to `list` that prints machine-readable output.
9. Write a test file covering add, list, done, rm, clear, and one error case.
10. Add a short README documenting each command with an example.

Requirements:
- Implement one feature at a time; after each, briefly confirm it works before
  moving on.
- Keep a running checklist of which numbered tasks are complete.
- At the end, report the full file list and which tasks are done.

This task is intentionally long enough that context management matters. Do not
abbreviate or declare completion until all ten items are genuinely implemented.
