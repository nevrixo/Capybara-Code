# Worktree fixtures

Inert Git worktree layouts for lease and merge coordinator tests.

Expectations:

- one writer lease per worktree
- generated paths only (no caller-supplied absolute escape)
- merge conflicts produce an edit plan, never conflict markers on disk
