/**
 * Bundled Skills — PRD §16.7.
 *
 * §16.7 names six: `code-review`, `test-triage`, `repo-onboarding`,
 * `write-agents-md`, `dependency-audit-lite`, and `commit-message` — the last
 * explicitly generating a message *without* committing, matching §12.2's decision
 * to ship no `git.commit` tool at all.
 *
 * These are kept as source so they ship inside the standalone binary (§19.2) and
 * are covered by the same tests as any other Skill. §16.7 also requires their
 * source and version to be visible and each one to be disableable.
 */

import type { SkillFile } from "./registry.ts";

export const BUILTIN_SKILL_VERSION = "1.0.0";

interface BuiltinSpec {
  readonly name: string;
  readonly description: string;
  readonly risk: string;
  readonly tools: readonly string[];
  readonly tags: readonly string[];
  readonly userInvocable: boolean;
  readonly body: string;
}

const BUILTINS: readonly BuiltinSpec[] = [
  {
    name: "code-review",
    description: "Review the current diff for correctness, regressions, security, and test gaps.",
    risk: "read",
    tools: ["git.diff", "git.status", "fs.read", "fs.search"],
    tags: ["review", "diff", "quality", "security"],
    userInvocable: true,
    body: `# Code review

Read the change before judging it. \`git.diff\` gives you the change; \`fs.read\` gives you the surrounding code that tells you whether the change is correct in context.

## What to look for, in order

1. **Correctness.** Does the code do what the diff claims? Check boundary conditions, empty inputs, and error paths — not just the happy path the author was thinking about.
2. **Regressions.** What else calls this? Use \`fs.search\` on the changed symbol names. A signature change with one updated call site is a finding.
3. **Security.** Untrusted input reaching a query, a path, a command, or a deserializer. Credentials or tokens in new code. Authorization checks that moved or disappeared.
4. **Test gaps.** Does a new behaviour have a test? Does a fixed bug have a regression test? Name the specific case that is missing.
5. **Data and migrations.** Irreversible operations, lock duration, and rollback.

## What to report

For each finding: severity, file and line, what goes wrong, and the smallest fix.

Do not report formatting, naming preferences, or a restatement of what the code does. If the change is sound, say so plainly and stop — a review that invents findings to look thorough costs the reader more than it gives them.`,
  },

  {
    name: "test-triage",
    description: "Run the tests closest to a change and explain each failure.",
    risk: "process",
    tools: ["fs.read", "fs.search", "fs.glob", "process.run", "git.diff"],
    tags: ["test", "failure", "triage", "debug"],
    userInvocable: true,
    body: `# Test triage

## Select before you run

Find the narrowest command that covers the change. Look for the project's own runner in its manifest — \`package.json\` scripts, \`Cargo.toml\`, \`pyproject.toml\`, \`Makefile\` — rather than assuming one.

Prefer a single file or filtered suite over the whole matrix. A full run that takes ten minutes to tell you the same thing is a worse answer.

## Read the failure, not the log

For each failing test, report:

- the test name and its file
- what was expected and what actually happened
- the specific line that raised
- whether the cause is the change under test or the environment

## Distinguish the two failure kinds

A **genuine failure** means the code is wrong. An **environment failure** — a missing binary, an absent dependency, no network — means the suite could not answer the question. Say which one you are looking at. "The suite could not run because X" is a useful result; a pass you did not observe is not.

## Before concluding

If a test fails, confirm it also fails without the change when that is cheap to check. A test that was already red is not evidence about this change.`,
  },

  {
    name: "repo-onboarding",
    description: "Explain an unfamiliar repository's structure, entry points, and how to run it.",
    risk: "read",
    tools: ["fs.read", "fs.list", "fs.glob", "fs.search", "git.log"],
    tags: ["onboarding", "explain", "structure", "architecture"],
    userInvocable: true,
    body: `# Repository onboarding

Answer the questions a new contributor actually has, in this order.

## 1. What is this?

Read the README and the root manifest. State the purpose in one or two sentences.

## 2. How is it laid out?

Name the top-level directories and what each holds. Skip vendored and generated trees. Do not list every file.

## 3. Where does execution start?

Find the real entry points: \`bin\` and \`scripts\` in a manifest, a \`main\`, a server bootstrap. Trace one representative request or command end to end so the reader has a spine to hang everything else on.

## 4. How do I build, run, and test it?

Quote the exact commands from the manifest. If they need a toolchain or a service, say so.

## 5. What should I know before changing anything?

Conventions from \`AGENTS.md\` or a contributing guide. Areas that look load-bearing. Recent churn from \`git.log\`, which tells you where the work is happening.

## Be honest about gaps

If you could not determine how to run the tests, say that. A confident wrong build command costs more than an admitted gap.`,
  },

  {
    name: "write-agents-md",
    description: "Draft or update an AGENTS.md capturing this project's real conventions.",
    risk: "write",
    tools: ["fs.read", "fs.list", "fs.glob", "fs.search", "fs.write"],
    tags: ["agents", "conventions", "documentation"],
    userInvocable: true,
    body: `# Writing AGENTS.md

\`AGENTS.md\` tells an agent how to work in *this* repository. It shapes behaviour; it grants no permission (§18.2).

## Derive it from the code, not from habit

Before writing a rule, confirm the repository follows it. Read the manifest for the real scripts. Read a few source files for the real style. A rule the code contradicts is worse than no rule, because it will be followed.

## Cover what an agent actually needs

- **Build, test, lint.** The exact commands, copied from the manifest.
- **Layout.** Where source, tests, and generated output live.
- **Conventions the code demonstrates.** Formatting, error handling, logging, naming.
- **Things not to touch.** Generated files, vendored trees, anything with its own pipeline.
- **Testing expectations.** Where a test goes and what shape it takes.

## Keep it short

Aim for something a reader finishes. Every line competes for the same context budget as the code. Prefer one accurate command over a paragraph describing it.

Write to \`AGENTS.md\` at the repository root unless a nearer scope is clearly meant.`,
  },

  {
    name: "dependency-audit-lite",
    description: "Review declared dependencies for risk without installing anything.",
    risk: "read",
    tools: ["fs.read", "fs.glob", "fs.search"],
    tags: ["dependencies", "supply-chain", "audit", "security"],
    userInvocable: true,
    body: `# Dependency audit (lite)

A read-only review of what the project declares. Install nothing and run no package-manager command — that would be a network side effect requiring its own approval (§13.2 R3).

## Read the manifests and the lockfile

Manifests state intent; the lockfile states what is actually resolved. Both matter, and they can disagree.

## What to flag

- **Unpinned ranges** on anything security-relevant. A caret range on an auth or crypto library is a supply-chain decision made by whoever publishes next.
- **Typosquat shapes.** A name one character from a popular package, or an unexpected scope.
- **Abandoned packages.** No release in years, sitting on a critical path.
- **Duplicated functionality.** Three HTTP clients is three attack surfaces.
- **Install scripts.** A \`postinstall\` runs arbitrary code at install time (§T9).
- **Direct dependencies that should be dev-only**, shipping to production for no reason.

## What to report

Group by severity. For each item: the package, the version or range, why it is a risk, and the concrete change — pin, replace, or remove.

State clearly that this is a static review of declared dependencies, not a vulnerability scan against an advisory database.`,
  },

  {
    name: "commit-message",
    description: "Write a commit message for the current change. Does not commit.",
    risk: "read",
    tools: ["git.diff", "git.status", "fs.read"],
    tags: ["git", "commit", "message"],
    userInvocable: true,
    body: `# Commit message

Produce a message for the staged or working-tree change. **Do not commit.** There is no commit tool, and running \`git commit\` through a shell would need its own approval (§12.2).

## Read the change first

\`git.status\` for scope, \`git.diff\` for content. Write about what the change does, not what the request asked for — those differ more often than you would expect.

## Shape

\`\`\`text
<subject: imperative, under 72 characters, no trailing period>

<body: why this change, and anything a reader could not infer from the diff>
\`\`\`

Match the repository's existing convention. If the log uses Conventional Commits, use it. Check \`git.log\` rather than guessing.

## Subject line

Imperative mood: "Fix the parser", not "Fixed" or "Fixes". Name the thing that changed. "Update code" says nothing.

## Body

Explain the reasoning the diff cannot: why this approach, what was rejected, what a reviewer should look at. Skip the body entirely for a genuinely trivial change rather than padding it.

Return the message as text for the user to use. Say explicitly that nothing was committed.`,
  },
];

/** Render the bundled Skills as `SKILL.md` files ready for the registry. */
export function builtinSkillFiles(): SkillFile[] {
  return BUILTINS.map((spec) => ({
    source: "builtin" as const,
    path: `<bundled>/skills/${spec.name}/SKILL.md`,
    content: renderBuiltin(spec),
  }));
}

export function builtinSkillNames(): string[] {
  return BUILTINS.map((spec) => spec.name).sort();
}

/**
 * §16.7 requires each bundled Skill to be disableable. Filtering at the file level
 * keeps a disabled Skill out of the catalog entirely, so it cannot be loaded by
 * name either (§16.4 stage 2 goes through the same registry).
 */
export function builtinSkillFilesExcept(disabled: readonly string[]): SkillFile[] {
  const skip = new Set(disabled);
  return builtinSkillFiles().filter((file) => {
    const name = file.path.split("/").at(-2);
    return name === undefined || !skip.has(name);
  });
}

function renderBuiltin(spec: BuiltinSpec): string {
  const lines = [
    "---",
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    `x-capybara-version: ${BUILTIN_SKILL_VERSION}`,
    "allowed-tools:",
    ...spec.tools.map((tool) => `  - ${tool}`),
    `x-capybara-risk: ${spec.risk}`,
    "tags:",
    ...spec.tags.map((tag) => `  - ${tag}`),
    `x-capybara-user-invocable: ${spec.userInvocable}`,
    "---",
    "",
    spec.body,
    "",
  ];
  return lines.join("\n");
}
