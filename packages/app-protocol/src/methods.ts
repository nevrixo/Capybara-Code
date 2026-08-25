/** Stable App Protocol method names. Runtime RPC method names are intentionally absent. */
export const APP_METHODS = [
  "server.initialize", "server.capabilities", "server.ping", "server.health", "server.version", "server.logs.tail",
  "workspace.open", "workspace.inspect", "workspace.list", "workspace.close", "workspace.trust.get", "workspace.trust.set", "workspace.services",
  "session.create", "session.list", "session.get", "session.attach", "session.detach", "session.ensure", "session.fork", "session.pause", "session.resume", "session.close", "session.archive", "session.export", "session.recover",
  "turn.submit", "turn.cancel", "turn.get", "turn.list", "turn.wait",
  "events.subscribe", "events.unsubscribe", "events.replay", "events.ack", "events.getSnapshot",
  "approval.list", "approval.get", "approval.resolve", "approval.cancel",
  "graph.get", "graph.listNodes", "graph.pause", "graph.resume", "graph.cancel",
  "task.spawn", "task.get", "task.wait", "task.message", "task.pause", "task.resume", "task.revive", "task.cancel",
  "memory.list", "memory.get", "memory.search", "memory.propose", "memory.remember", "memory.forget", "memory.resolveContest", "memory.verify",
  "lsp.status", "lsp.diagnostics", "lsp.definition", "lsp.references", "lsp.hover", "lsp.rename.preview", "lsp.rename.apply", "lsp.codeActions", "lsp.codeAction.apply",
  "edit.preview", "edit.apply", "edit.getReceipt", "diff.get", "diff.getFile",
  "worktree.list", "worktree.get", "worktree.getProposal", "worktree.discard", "merge.preview", "merge.apply", "merge.resolve",
  "plugin.list", "plugin.inspect", "plugin.install", "plugin.update", "plugin.enable", "plugin.disable", "plugin.grants", "plugin.resolveGrant",
  "artifact.getMetadata", "artifact.read", "artifact.stream", "artifact.export",
] as const;

export type AppMethod = typeof APP_METHODS[number];

export function isAppMethod(method: string): method is AppMethod {
  return (APP_METHODS as readonly string[]).includes(method);
}
