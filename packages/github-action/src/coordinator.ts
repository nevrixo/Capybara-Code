import {
  validateActionResult,
  type ActionResult,
  type TriggerEnvelope,
} from "@cbc/integration-core";

export type GitHubSideEffectKind = "comment" | "commit" | "pull-request" | "annotations" | "artifact";

export interface GitHubSideEffectReceipt {
  readonly key: string;
  readonly kind: GitHubSideEffectKind;
  readonly externalId: string;
  readonly completedAt: string;
}

export interface GitHubSideEffectJournal {
  executeOnce(
    input: {
      readonly key: string;
      readonly kind: GitHubSideEffectKind;
      readonly completedAt: string;
    },
    operation: () => Promise<string>,
  ): Promise<GitHubSideEffectReceipt>;
}

export interface GitHubWriter {
  comment(input: {
    readonly repository: string;
    readonly body: string;
  }): Promise<{ readonly id: string }>;
  commit?(input: {
    readonly repository: string;
    readonly expectedHeadSha: string;
    readonly changedFiles: readonly string[];
    readonly message: string;
  }): Promise<{ readonly sha: string }>;
  pullRequest?(input: {
    readonly repository: string;
    readonly headSha: string;
    readonly summary: string;
  }): Promise<{ readonly number: number }>;
  annotations?(input: {
    readonly repository: string;
    readonly annotations: readonly Readonly<Record<string, unknown>>[];
  }): Promise<{ readonly id: string }>;
  artifact?(input: {
    readonly repository: string;
    readonly artifacts: readonly Readonly<Record<string, unknown>>[];
  }): Promise<{ readonly id: string }>;
}

export interface GitHubWritePolicy {
  readonly comment?: boolean;
  readonly commit?: boolean;
  readonly pullRequest?: boolean;
  readonly annotations?: boolean;
  readonly artifacts?: boolean;
  readonly allowWorkflowChanges?: boolean;
  readonly now?: () => string;
}

export class InMemoryGitHubSideEffectJournal implements GitHubSideEffectJournal {
  readonly #receipts = new Map<string, GitHubSideEffectReceipt>();
  readonly #pending = new Map<string, Promise<GitHubSideEffectReceipt>>();

  async executeOnce(
    input: {
      readonly key: string;
      readonly kind: GitHubSideEffectKind;
      readonly completedAt: string;
    },
    operation: () => Promise<string>,
  ): Promise<GitHubSideEffectReceipt> {
    const existing = this.#receipts.get(input.key);
    if (existing !== undefined) return existing;
    const inFlight = this.#pending.get(input.key);
    if (inFlight !== undefined) return inFlight;
    const pending = (async () => {
      const externalId = await operation();
      const receipt = Object.freeze({ ...input, externalId });
      this.#receipts.set(input.key, receipt);
      return receipt;
    })();
    this.#pending.set(input.key, pending);
    try {
      return await pending;
    } finally {
      if (this.#pending.get(input.key) === pending) this.#pending.delete(input.key);
    }
  }
}

/**
 * The only component allowed to create GitHub side effects. It consumes a
 * validated action result, never natural-language claims from the agent.
 */
export class GitHubWriteCoordinator {
  readonly #writer: GitHubWriter;
  readonly #journal: GitHubSideEffectJournal;
  readonly #policy: GitHubWritePolicy;
  readonly #now: () => string;

  constructor(input: {
    readonly writer: GitHubWriter;
    readonly journal: GitHubSideEffectJournal;
    readonly policy?: GitHubWritePolicy;
  }) {
    this.#writer = input.writer;
    this.#journal = input.journal;
    this.#policy = input.policy ?? {};
    this.#now = input.policy?.now ?? (() => new Date().toISOString());
  }

  async reconcile(
    trigger: TriggerEnvelope,
    untrustedResult: ActionResult,
  ): Promise<readonly GitHubSideEffectReceipt[]> {
    const result = validateActionResult(untrustedResult);
    if (!trigger.trusted && (this.#policy.commit === true || this.#policy.pullRequest === true)) {
      throw new Error("untrusted GitHub triggers cannot create commits or pull requests");
    }
    if (
      this.#policy.allowWorkflowChanges !== true
      && result.changedFiles.some((path) => normalizePath(path).startsWith(".github/workflows/"))
    ) {
      throw new Error("workflow file changes require an explicit coordinator policy");
    }
    if ((this.#policy.commit === true || this.#policy.pullRequest === true) && result.status !== "completed") {
      throw new Error("commit and pull-request side effects require a completed action result");
    }
    if (
      (this.#policy.commit === true || this.#policy.pullRequest === true)
      && result.verification.some((entry) => entry.status !== "passed")
    ) {
      throw new Error("commit and pull-request side effects require passing verification receipts");
    }

    const receipts: GitHubSideEffectReceipt[] = [];
    if (this.#policy.comment !== false) {
      receipts.push(await this.#once(trigger, "comment", async () => {
        const created = await this.#writer.comment({
          repository: trigger.repository,
          body: boundedSummary(result),
        });
        return created.id;
      }));
    }
    let committedSha = result.commitSha;
    if (this.#policy.commit === true) {
      if (this.#writer.commit === undefined) throw new Error("GitHub commit writer is unavailable");
      const receipt = await this.#once(trigger, "commit", async () => {
        const created = await this.#writer.commit!({
          repository: trigger.repository,
          expectedHeadSha: trigger.headSha,
          changedFiles: result.changedFiles,
          message: "Capybara: " + result.summary.slice(0, 120),
        });
        committedSha = created.sha;
        return created.sha;
      });
      receipts.push(receipt);
      committedSha ??= receipt.externalId;
    }
    if (this.#policy.pullRequest === true) {
      if (this.#writer.pullRequest === undefined) throw new Error("GitHub pull-request writer is unavailable");
      if (committedSha === null) throw new Error("pull request requires a validated commit SHA");
      receipts.push(await this.#once(trigger, "pull-request", async () => {
        const created = await this.#writer.pullRequest!({
          repository: trigger.repository,
          headSha: committedSha!,
          summary: result.summary,
        });
        return String(created.number);
      }));
    }
    if (this.#policy.annotations === true && result.annotations.length > 0) {
      if (this.#writer.annotations === undefined) throw new Error("GitHub annotation writer is unavailable");
      receipts.push(await this.#once(trigger, "annotations", async () => {
        const created = await this.#writer.annotations!({
          repository: trigger.repository,
          annotations: result.annotations,
        });
        return created.id;
      }));
    }
    if (this.#policy.artifacts === true && result.artifacts.length > 0) {
      if (this.#writer.artifact === undefined) throw new Error("GitHub artifact writer is unavailable");
      receipts.push(await this.#once(trigger, "artifact", async () => {
        const created = await this.#writer.artifact!({
          repository: trigger.repository,
          artifacts: result.artifacts,
        });
        return created.id;
      }));
    }
    return Object.freeze(receipts);
  }

  async #once(
    trigger: TriggerEnvelope,
    kind: GitHubSideEffectKind,
    execute: () => Promise<string>,
  ): Promise<GitHubSideEffectReceipt> {
    const key = trigger.idempotencyKey + ":" + kind;
    return this.#journal.executeOnce({
      key,
      kind,
      completedAt: this.#now(),
    }, execute);
  }
}

function boundedSummary(result: ActionResult): string {
  const files = result.changedFiles.length === 0
    ? ""
    : "\n\nChanged files:\n" + result.changedFiles.slice(0, 100).map((path) => "- " + path).join("\n");
  return (result.summary + files).slice(0, 60_000);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}
