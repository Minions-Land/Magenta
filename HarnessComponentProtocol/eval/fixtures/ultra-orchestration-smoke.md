Perform a small orchestration preflight in this repository.

1. Use a workflow sub-agent to inspect `HarnessComponentProtocol/eval/README.md` and return its purpose in one sentence.
2. Use `multiagent start` once with a bootstrap prompt asking one persistent teammate Session to identify the eval scenario filenames and explicitly send its result to Main with `send_message`. End the turn rather than polling. After its mailbox result activates Main, stop that Session by `sessionId`.
3. Return a compact JSON object with keys `workflow`, `teammate`, and `ok`. Set `ok` to true only if both delegated checks completed.

Inherit the configured model for every delegated call; do not set provider or model. Do not modify files. Do not leave delegated or background work running.
