import { CapybaraClient } from "@cbc/sdk";

import { daemonStatus } from "../../../capy-daemon/src/daemon.ts";
import { resolveInstanceLockPaths } from "../../../capy-daemon/src/instance-lock.ts";
import { CliError, EXIT } from "../exit.ts";
import { join } from "../host.ts";
import { ok, type CommandContext, type CommandResult } from "./context.ts";

export type IntegrationTarget = "vscode" | "acp" | "github";

export async function clientsCommand(
  context: CommandContext,
  sub: "list" | "doctor",
): Promise<CommandResult> {
  const inspection = await inspectAppServer(context);
  if (sub === "list") {
    context.out(JSON.stringify({
      connectedClient: inspection.clientId,
      roles: inspection.roles,
      inventory: {
        state: "unsupported",
        reason: "this daemon does not expose other client identities yet",
      },
    }, null, 2));
    return ok();
  }
  context.out(JSON.stringify({
    daemon: inspection.daemon,
    transport: inspection.snapshot.transport,
    capabilityDigest: inspection.snapshot.snapshotDigest,
    replay: inspection.snapshot.events,
    currentClientRoles: inspection.roles,
    clientInventory: "unsupported",
  }, null, 2));
  return ok();
}

export async function integrationDoctor(
  context: CommandContext,
  target?: IntegrationTarget,
): Promise<CommandResult> {
  const inspection = target === "github" ? undefined : await inspectAppServer(context);
  const checks: Array<Readonly<Record<string, unknown>>> = [];
  if (target === undefined || target === "acp") {
    checks.push({
      integration: "acp",
      status: inspection !== undefined
        && available(inspection.snapshot, ["session.attach", "turn.submit", "events.replay"])
        ? "ready"
        : "unsupported",
      framing: "ndjson",
      protocolVersion: 1,
    });
  }
  if (target === undefined || target === "vscode") {
    checks.push({
      integration: "vscode",
      status: inspection !== undefined
        && available(inspection.snapshot, ["session.attach", "turn.submit"])
        ? "ready"
        : "unsupported",
      richDiff: inspection?.snapshot.presentation.richDiff ?? false,
      inlineApprovals: inspection?.snapshot.presentation.inlineApprovals ?? false,
      reconnect: inspection !== undefined
        && inspection.snapshot.events.replay
        && inspection.snapshot.events.ack,
    });
  }
  if (target === undefined || target === "github") {
    const workflow = join(context.workspacePath, ".github", "workflows", "capybara-code.yml");
    const content = await context.host.fs.read(workflow);
    checks.push({
      integration: "github",
      status: content === undefined ? "not-installed" : workflowHealth(content),
      workflow,
      headlessApprovalPolicy: content?.includes("permission-policy:") === true,
    });
  }
  context.out(JSON.stringify({
    daemon: inspection?.daemon ?? { status: "not-required" },
    checks,
  }, null, 2));
  return ok();
}

export async function githubCommand(
  context: CommandContext,
  sub: "install" | "doctor",
): Promise<CommandResult> {
  if (sub === "doctor") return integrationDoctor(context, "github");
  const directory = join(context.workspacePath, ".github", "workflows");
  const path = join(directory, "capybara-code.yml");
  await context.host.fs.mkdirp(directory);
  const written = context.host.fs.writeNew === undefined
    ? await writeWhenAbsent(context, path, GITHUB_WORKFLOW)
    : await context.host.fs.writeNew(path, GITHUB_WORKFLOW);
  if (!written) {
    throw new CliError(
      EXIT.config,
      "GitHub workflow already exists",
      [path, "Refusing to overwrite it; run capy github doctor instead."],
    );
  }
  context.out("Installed " + path);
  return ok();
}

async function inspectAppServer(context: CommandContext) {
  const runtimeDir = context.host.env.CAPY_DAEMON_RUNTIME_DIR;
  const status = daemonStatus(runtimeDir);
  if (!status.running || status.record === undefined) {
    throw new CliError(EXIT.internal, "Capybara daemon is not running", [
      "Run capy daemon start first.",
    ]);
  }
  const path = resolveInstanceLockPaths(runtimeDir).socketPath;
  const client = await CapybaraClient.connect({
    transport: context.host.platform === "win32" ? "pipe" : "unix",
    path,
    client: {
      name: "Capybara integration doctor",
      version: context.version,
      kind: "cli",
    },
  });
  try {
    const result = await client.request<{
      readonly roles: readonly string[];
      readonly capabilitySnapshot: NonNullable<typeof client.initializeResult>["capabilitySnapshot"];
    }>("server.capabilities");
    return {
      clientId: client.clientId,
      roles: result.roles,
      snapshot: result.capabilitySnapshot,
      daemon: {
        daemonId: status.record.daemonId,
        pid: status.record.pid,
        socketPath: path,
      },
    };
  } finally {
    await client.close();
  }
}

function available(
  snapshot: { readonly methods: Readonly<Record<string, { readonly state: string }>> },
  methods: readonly string[],
): boolean {
  return methods.every((method) => snapshot.methods[method]?.state === "available");
}

function workflowHealth(content: string): "ready" | "invalid" {
  return content.includes("nevrixo/capybara-code-action@v1")
    && content.includes("permission-policy:")
    && content.includes("pull-requests: write")
    ? "ready"
    : "invalid";
}

async function writeWhenAbsent(
  context: CommandContext,
  path: string,
  content: string,
): Promise<boolean> {
  if (await context.host.fs.exists(path)) return false;
  await context.host.fs.write(path, content);
  return true;
}

const GITHUB_WORKFLOW = [
  "name: Capybara Code",
  "",
  "on:",
  "  issue_comment:",
  "    types: [created]",
  "  pull_request_review_comment:",
  "    types: [created]",
  "  workflow_dispatch:",
  "",
  "permissions:",
  "  contents: write",
  "  pull-requests: write",
  "  issues: write",
  "",
  "jobs:",
  "  capybara:",
  "    if: github.event_name != 'issue_comment' || contains(github.event.comment.body, '/capy')",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "        with:",
  "          fetch-depth: 0",
  "      - uses: nevrixo/capybara-code-action@v1",
  "        with:",
  "          mode: auto",
  "          permission-policy: allow-listed",
  "",
].join("\n");
