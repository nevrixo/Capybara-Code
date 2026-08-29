# Capybara ACP adapter

capy acp implements the stable ACP v1 JSON-RPC lifecycle over newline-delimited
stdio and maps it to Capybara App Protocol sessions.

Supported baseline methods are initialize, session/new, session/prompt, and
session/cancel; session/load is advertised only when the daemon supports it.
Capybara-specific graph, worktree, memory-contest, and plugin-grant state is exposed
only through ACP metadata extensions.

The adapter never advertises client filesystem or terminal authority. All tools,
edits, approvals, credentials, and processes remain owned by the Capybara runtime.
