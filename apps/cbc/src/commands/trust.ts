import { CliError, EXIT } from "../exit.ts";
import { projectTrustWidening } from "../project-trust.ts";
import { trustKey } from "../state.ts";
import { ensureTrust } from "../workspace-trust.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

export async function trustCommand(
  context: CommandContext,
  options: { readonly showDiff: boolean },
): Promise<CommandResult> {
  const snapshot = await context.projectTrustSnapshot();
  const store = await context.projectControlTrustStore();
  const approved = store.records[trustKey(context.workspacePath)]?.project;
  const state = await context.trust();
  const addedCapabilities = projectTrustWidening(approved, snapshot);
  const report = {
    workspace: context.workspacePath,
    state,
    changed: snapshot.hasProjectControlFiles
      && approved?.projectDigest !== snapshot.projectDigest,
    approvedDigest: approved?.projectDigest ?? null,
    currentDigest: snapshot.projectDigest,
    addedCapabilities,
    requestedCapabilities: snapshot.requestedCapabilities,
    files: {
      configDigest: snapshot.configDigest,
      packageManifestDigest: snapshot.packageManifestDigest,
      packageLockDigest: snapshot.packageLockDigest,
      executableDigest: snapshot.executableDigest,
      capabilityDigest: snapshot.capabilityDigest,
    },
  };
  if (options.showDiff) {
    context.out(JSON.stringify(report, null, 2));
    return ok();
  }
  if (context.nonInteractive) {
    throw new CliError(
      EXIT.permission,
      "capy trust requires an interactive terminal",
      ["Use capy trust --show-diff for a read-only CI inspection."],
    );
  }
  if (state === "trusted-always" || state === "trusted-once") {
    context.out("Workspace trust is current: " + snapshot.projectDigest);
    return ok();
  }
  const decision = await ensureTrust(context);
  if (decision === "exit") return { code: EXIT.cancelled };
  context.out("Workspace trust: " + decision);
  return ok();
}
