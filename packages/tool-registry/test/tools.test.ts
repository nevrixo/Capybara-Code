/**
 * Tool registry tests — PRD §12, §25.2, AC-09, AC-10, AC-23, TOOL-002, TOOL-005,
 * SUB-003, R-08.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SCHEDULER_LIMITS,
  NATIVE_TOOLS,
  nativeToolsForFeatures,
  ToolRegistry,
  allowsBroadRule,
  createLease,
  discover,
  errorResult,
  findTool,
  globMatch,
  leaseExpired,
  okResult,
  parseAndValidate,
  rankTools,
  reconcileLease,
  renderDiscoveryBlock,
  renderValidationErrors,
  schedule,
  validate,
  type ProposedCall,
  type RiskClass,
} from "../src/index.ts";

describe("catalog completeness (§12.2)", () => {
  test("includes every P0 tool the PRD lists", () => {
    const ids = NATIVE_TOOLS.map((t) => t.id);
    for (const id of [
      "fs.read",
      "fs.read_many",
      "fs.list",
      "fs.glob",
      "fs.search",
      "fs.apply_patch",
      "fs.write",
      "fs.move",
      "fs.delete",
      "process.run",
      "process.start",
      "process.input",
      "process.stop",
      "shell.run",
      "git.status",
      "git.diff",
      "git.log",
      "git.show",
      "git.checkpoint",
      "user.ask",
      "task.search",
      "task.spawn",
      "task.status",
      "task.cancel",
      "skill.search",
      "skill.load",
      "mcp.search",
      "mcp.call",
      "mcp.read_resource",
    ]) {
      expect(ids).toContain(id);
    }
  });

  test("omits git.commit, git.push, and git reset --hard (§12.2)", () => {
    const ids = NATIVE_TOOLS.map((t) => t.id);
    expect(ids).not.toContain("git.commit");
    expect(ids).not.toContain("git.push");
    expect(ids).not.toContain("git.reset");
  });

  test("every schema is strict with additionalProperties:false (§12.4)", () => {
    for (const tool of NATIVE_TOOLS) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.additionalProperties).toBe(false);
    }
  });

  test("process tools require an explicit timeout (§12.4)", () => {
    for (const id of ["process.run", "process.start", "shell.run"]) {
      const tool = findTool(id)!;
      expect((tool.parameters.required as string[])).toContain("timeoutMs");
      const properties = tool.parameters.properties as Record<string, Record<string, unknown>>;
      expect(properties.maxOutputBytes).toBeDefined();
    }
  });

  test("mutation tools carry an expected hash or create policy (§12.4)", () => {
    const write = findTool("fs.write")!;
    const properties = write.parameters.properties as Record<string, unknown>;
    expect(properties.intent).toBeDefined();
    expect(properties.expectedHash).toBeDefined();
    const patch = findTool("fs.apply_patch")!;
    expect((patch.parameters.properties as Record<string, unknown>).expectedHashes).toBeDefined();
  });

  test("process.run takes program plus argv, not a command string (§12.3)", () => {
    const tool = findTool("process.run")!;
    const properties = tool.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.program?.type).toBe("string");
    expect(properties.args?.type).toBe("array");
    expect(properties.command).toBeUndefined();
  });

  test("shell.run defaults to an approval-gated risk (§12.3, TOOL-003)", () => {
    expect(findTool("shell.run")!.defaultRisk).toBe("R3");
    expect(findTool("process.run")!.defaultRisk).toBe("R1");
  });

  test("task.spawn requires goal, constraints, and contract (SUB-002)", () => {
    const required = findTool("task.spawn")!.parameters.required as string[];
    expect(required).toContain("goal");
    expect(required).toContain("constraints");
    expect(required).toContain("expectedOutput");
  });

  test("task.spawn goal floor matches the §15.4 validator (MIN_GOAL_LENGTH)", () => {
    // A goal shorter than 20 chars must be refused by the schema *before* it is
    // sent, not pass the schema and then fail validateTask with INVALID_ARGUMENT.
    const goalSchema = (findTool("task.spawn")!.parameters.properties as Record<string, { minLength?: number }>).goal!;
    expect(goalSchema.minLength).toBe(20);
    const short = parseAndValidate(
      JSON.stringify({
        role: "explore",
        title: "T",
        goal: "survey the codebase", // 19 chars
        constraints: ["read-only"],
        expectedOutput: ["a map of modules"],
      }),
      findTool("task.spawn")!.parameters,
    );
    expect(short.ok).toBe(false);
    expect(short.errors.some((e) => e.path === "goal")).toBe(true);
  });

  test("R4-R6 cannot receive a broad allow rule (§13.2, PERM-002)", () => {
    for (const risk of ["R0", "R1", "R2", "R3"] as RiskClass[]) {
      expect(allowsBroadRule(risk)).toBe(true);
    }
    for (const risk of ["R4", "R5", "R6"] as RiskClass[]) {
      expect(allowsBroadRule(risk)).toBe(false);
    }
  });

  test("only the essential tools are always active (§6.9, R-08)", () => {
    const always = NATIVE_TOOLS.filter((t) => t.alwaysActive).map((t) => t.id);
    // Reading, searching, patching, and running must never require discovery,
    // or R-08's "discovery hides a required tool" risk materializes.
    expect(always).toContain("fs.read");
    expect(always).toContain("fs.search");
    expect(always).toContain("fs.apply_patch");
    expect(always).toContain("process.run");
    expect(always).toContain("tool.discover");
    // Subagent and MCP tools are discovered on demand (AC-09).
    expect(always).not.toContain("task.spawn");
    expect(always).not.toContain("mcp.call");
    expect(always).not.toContain("shell.run");
  });

  test("structured edit is opt-in through editEngineV2", () => {
    const disabled = nativeToolsForFeatures().map((tool) => tool.id);
    const enabled = nativeToolsForFeatures({ editEngineV2: true }).map((tool) => tool.id);
    expect(NATIVE_TOOLS.map((tool) => tool.id)).toEqual(
      expect.arrayContaining(["fs.edit.preview", "fs.edit"]),
    );
    expect(disabled).not.toEqual(expect.arrayContaining(["fs.edit.preview", "fs.edit"]));
    expect(enabled).toEqual(expect.arrayContaining(["fs.edit.preview", "fs.edit"]));
    expect(new ToolRegistry().has("fs.edit")).toBe(false);
    expect(new ToolRegistry(nativeToolsForFeatures({ editEngineV2: true })).activeIds()).toEqual(
      expect.arrayContaining(["fs.edit.preview", "fs.edit"]),
    );
  });

  test("plugin.invoke is opt-in through pluginRuntime and stays in the registry", () => {
    const disabled = nativeToolsForFeatures().map((tool) => tool.id);
    const enabled = nativeToolsForFeatures({ pluginRuntime: true }).map((tool) => tool.id);
    expect(disabled).not.toContain("plugin.invoke");
    expect(enabled).toContain("plugin.invoke");
    const registry = new ToolRegistry(nativeToolsForFeatures({ pluginRuntime: true }));
    expect(registry.has("plugin.invoke")).toBe(true);
  });

  test("durable memory is opt-in through durableMemory", () => {
    const disabled = nativeToolsForFeatures().map((tool) => tool.id);
    const enabled = nativeToolsForFeatures({ durableMemory: true }).map((tool) => tool.id);
    expect(NATIVE_TOOLS.map((tool) => tool.id)).toEqual(
      expect.arrayContaining(["memory.search", "memory.remember"]),
    );
    expect(disabled).not.toEqual(expect.arrayContaining(["memory.search", "memory.remember"]));
    expect(enabled).toEqual(expect.arrayContaining(["memory.search", "memory.remember"]));
    expect(new ToolRegistry().has("memory.remember")).toBe(false);
    const registry = new ToolRegistry(nativeToolsForFeatures({ durableMemory: true }));
    expect(registry.has("memory.search")).toBe(true);
    expect(registry.has("memory.remember")).toBe(true);
    expect(registry.activeIds()).not.toEqual(expect.arrayContaining(["memory.search", "memory.remember"]));
  });

  test("LSP read tools are opt-in through fullLsp", () => {
    const lspTools = [
      "lsp.diagnostics",
      "lsp.symbols",
      "lsp.workspace_symbols",
      "lsp.definition",
      "lsp.declaration",
      "lsp.type_definition",
      "lsp.implementation",
      "lsp.references",
      "lsp.hover",
      "lsp.signature_help",
      "lsp.document_highlights",
      "lsp.call_hierarchy",
      "lsp.code_actions",
    ];
    const disabled = nativeToolsForFeatures().map((tool) => tool.id);
    const enabled = nativeToolsForFeatures({ fullLsp: true }).map((tool) => tool.id);

    expect(NATIVE_TOOLS.map((tool) => tool.id)).toEqual(expect.arrayContaining(lspTools));
    expect(disabled).not.toEqual(expect.arrayContaining(lspTools));
    expect(enabled).toEqual(expect.arrayContaining(lspTools));

    const registry = new ToolRegistry(nativeToolsForFeatures({ fullLsp: true }));
    for (const id of lspTools) {
      expect(new ToolRegistry().has(id)).toBe(false);
      expect(registry.has(id)).toBe(true);
    }

    expect(findTool("lsp.diagnostics")).toMatchObject({
      authority: "read",
      idempotency: "pure",
      maxParallelism: 2,
      resultSchemaId: "lsp.diagnostics.v1",
    });
    for (const id of [
      "lsp.symbols",
      "lsp.workspace_symbols",
      "lsp.definition",
      "lsp.declaration",
      "lsp.type_definition",
      "lsp.implementation",
      "lsp.references",
      "lsp.hover",
      "lsp.signature_help",
      "lsp.document_highlights",
      "lsp.code_actions",
    ]) {
      expect(findTool(id)).toMatchObject({
        authority: "read",
        idempotency: "idempotent",
        maxParallelism: 2,
        resultSchemaId: id + ".v1",
      });
    }

    expect(findTool("lsp.call_hierarchy")).toMatchObject({
      authority: "read",
      idempotency: "idempotent",
      maxParallelism: 1,
      resultSchemaId: "lsp.call_hierarchy.v1",
    });

    const referencesSchema = findTool("lsp.references")!.parameters;
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: 0,
      character: 4,
      includeDeclaration: false,
    }), referencesSchema).ok).toBe(true);
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: -1,
      character: 4,
    }), referencesSchema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: 0,
      character: 4,
      unexpected: true,
    }), referencesSchema).ok).toBe(false);

    const documentHighlightsSchema = findTool("lsp.document_highlights")!.parameters;
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: 0,
      character: 4,
    }), documentHighlightsSchema).ok).toBe(true);
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: -1,
      character: 4,
    }), documentHighlightsSchema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: 0,
      character: 4,
      unexpected: true,
    }), documentHighlightsSchema).ok).toBe(false);

    const callHierarchySchema = findTool("lsp.call_hierarchy")!.parameters;
    const callHierarchyInput = {
      path: "src/widget.ts",
      line: 0,
      character: 4,
      direction: "incoming",
    };
    expect(parseAndValidate(JSON.stringify(callHierarchyInput), callHierarchySchema).ok).toBe(true);
    expect(parseAndValidate(JSON.stringify({
      ...callHierarchyInput,
      direction: "sideways",
    }), callHierarchySchema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({
      ...callHierarchyInput,
      offset: 257,
    }), callHierarchySchema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({
      ...callHierarchyInput,
      limit: 33,
    }), callHierarchySchema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({
      ...callHierarchyInput,
      unexpected: true,
    }), callHierarchySchema).ok).toBe(false);

    const symbolsSchema = findTool("lsp.symbols")!.parameters;
    expect(parseAndValidate(JSON.stringify({ path: "src/widget.ts" }), symbolsSchema).ok).toBe(true);
    expect(parseAndValidate(JSON.stringify({ path: "src/widget.ts", line: 0 }), symbolsSchema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({ path: "a".repeat(513) }), symbolsSchema).ok).toBe(false);

    const workspaceSymbolsSchema = findTool("lsp.workspace_symbols")!.parameters;
    expect(parseAndValidate(JSON.stringify({ query: "Widget" }), workspaceSymbolsSchema).ok).toBe(true);
    expect(parseAndValidate(JSON.stringify({ query: "" }), workspaceSymbolsSchema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({ query: "a".repeat(513) }), workspaceSymbolsSchema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({
      query: "Widget",
      path: "src/widget.ts",
    }), workspaceSymbolsSchema).ok).toBe(false);
  });
});

describe("LSP rename preview feature gate", () => {
  test("requires full LSP, the structured edit engine, and its dedicated mutation gate", () => {
    const id = "lsp.rename_preview";
    const disabled = nativeToolsForFeatures().map((tool) => tool.id);
    const missingFullLsp = nativeToolsForFeatures({
      editEngineV2: true,
      lspRenamePreview: true,
    }).map((tool) => tool.id);
    const missingEditEngine = nativeToolsForFeatures({
      fullLsp: true,
      lspRenamePreview: true,
    }).map((tool) => tool.id);
    const missingRenameGate = nativeToolsForFeatures({
      fullLsp: true,
      editEngineV2: true,
    }).map((tool) => tool.id);
    const enabled = nativeToolsForFeatures({
      fullLsp: true,
      editEngineV2: true,
      lspRenamePreview: true,
    }).map((tool) => tool.id);

    expect(disabled).not.toContain(id);
    expect(missingFullLsp).not.toContain(id);
    expect(missingEditEngine).not.toContain(id);
    expect(missingRenameGate).not.toContain(id);
    expect(enabled).toContain(id);
    expect(findTool(id)).toMatchObject({
      authority: "read",
      idempotency: "idempotent",
      maxParallelism: 1,
      resultSchemaId: "lsp.rename_preview.v1",
    });

    const schema = findTool(id)!.parameters;
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      newName: "Renamed",
    }), schema).ok).toBe(true);
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      newName: "",
    }), schema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      newName: "Renamed",
      unexpected: true,
    }), schema).ok).toBe(false);
  });
});

describe("LSP code action preview feature gate", () => {
  test("requires full LSP, the structured edit engine, and the code action mutation gate", () => {
    const id = "lsp.code_action_preview";
    const disabled = nativeToolsForFeatures().map((tool) => tool.id);
    const missingFullLsp = nativeToolsForFeatures({
      editEngineV2: true,
      lspCodeActionPreview: true,
    }).map((tool) => tool.id);
    const missingEditEngine = nativeToolsForFeatures({
      fullLsp: true,
      lspCodeActionPreview: true,
    }).map((tool) => tool.id);
    const missingCodeActionGate = nativeToolsForFeatures({
      fullLsp: true,
      editEngineV2: true,
    }).map((tool) => tool.id);
    const enabled = nativeToolsForFeatures({
      fullLsp: true,
      editEngineV2: true,
      lspCodeActionPreview: true,
    }).map((tool) => tool.id);

    expect(NATIVE_TOOLS.map((tool) => tool.id)).toContain(id);
    expect(disabled).not.toContain(id);
    expect(missingFullLsp).not.toContain(id);
    expect(missingEditEngine).not.toContain(id);
    expect(missingCodeActionGate).not.toContain(id);
    expect(enabled).toContain(id);
    expect(findTool(id)).toMatchObject({
      authority: "read",
      idempotency: "idempotent",
      maxParallelism: 1,
      resultSchemaId: "lsp.code_action_preview.v1",
    });

    const schema = findTool(id)!.parameters;
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      actionIndex: 255,
    }), schema).ok).toBe(true);
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      actionIndex: -1,
    }), schema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      actionIndex: 256,
    }), schema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      actionIndex: 1.5,
    }), schema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      line: 0,
      character: 13,
      actionIndex: 1,
      unexpected: true,
    }), schema).ok).toBe(false);
  });
});

describe("LSP formatting preview feature gate", () => {
  test("requires full LSP, the structured edit engine, and the formatting mutation gate", () => {
    const id = "lsp.format_preview";
    const disabled = nativeToolsForFeatures().map((tool) => tool.id);
    const missingFullLsp = nativeToolsForFeatures({
      editEngineV2: true,
      lspFormattingPreview: true,
    }).map((tool) => tool.id);
    const missingEditEngine = nativeToolsForFeatures({
      fullLsp: true,
      lspFormattingPreview: true,
    }).map((tool) => tool.id);
    const missingFormattingGate = nativeToolsForFeatures({
      fullLsp: true,
      editEngineV2: true,
    }).map((tool) => tool.id);
    const enabled = nativeToolsForFeatures({
      fullLsp: true,
      editEngineV2: true,
      lspFormattingPreview: true,
    }).map((tool) => tool.id);

    expect(NATIVE_TOOLS.map((tool) => tool.id)).toContain(id);
    expect(disabled).not.toContain(id);
    expect(missingFullLsp).not.toContain(id);
    expect(missingEditEngine).not.toContain(id);
    expect(missingFormattingGate).not.toContain(id);
    expect(enabled).toContain(id);
    expect(findTool(id)).toMatchObject({
      authority: "read",
      idempotency: "idempotent",
      maxParallelism: 1,
      resultSchemaId: "lsp.format_preview.v1",
    });

    const schema = findTool(id)!.parameters;
    expect(parseAndValidate(JSON.stringify({ path: "src/widget.ts" }), schema).ok).toBe(true);
    expect(parseAndValidate(JSON.stringify({ path: "" }), schema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({ path: "a".repeat(513) }), schema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({
      path: "src/widget.ts",
      unexpected: true,
    }), schema).ok).toBe(false);
  });
});

describe("LSP range formatting preview feature gate", () => {
  test("shares the formatting mutation gate and validates bounded range coordinates", () => {
    const id = "lsp.range_format_preview";
    const disabled = nativeToolsForFeatures().map((tool) => tool.id);
    const missingFullLsp = nativeToolsForFeatures({
      editEngineV2: true,
      lspFormattingPreview: true,
    }).map((tool) => tool.id);
    const missingEditEngine = nativeToolsForFeatures({
      fullLsp: true,
      lspFormattingPreview: true,
    }).map((tool) => tool.id);
    const missingFormattingGate = nativeToolsForFeatures({
      fullLsp: true,
      editEngineV2: true,
    }).map((tool) => tool.id);
    const enabled = nativeToolsForFeatures({
      fullLsp: true,
      editEngineV2: true,
      lspFormattingPreview: true,
    }).map((tool) => tool.id);

    expect(NATIVE_TOOLS.map((tool) => tool.id)).toContain(id);
    expect(disabled).not.toContain(id);
    expect(missingFullLsp).not.toContain(id);
    expect(missingEditEngine).not.toContain(id);
    expect(missingFormattingGate).not.toContain(id);
    expect(enabled).toContain(id);
    expect(findTool(id)).toMatchObject({
      authority: "read",
      idempotency: "idempotent",
      maxParallelism: 1,
      resultSchemaId: "lsp.range_format_preview.v1",
    });

    const schema = findTool(id)!.parameters;
    const valid = {
      path: "src/widget.ts",
      startLine: 0,
      startCharacter: 19,
      endLine: 0,
      endCharacter: 21,
    };
    expect(parseAndValidate(JSON.stringify(valid), schema).ok).toBe(true);
    expect(parseAndValidate(JSON.stringify({ ...valid, endCharacter: 1_000_001 }), schema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({ ...valid, startLine: -1 }), schema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({ ...valid, unexpected: true }), schema).ok).toBe(false);
  });
});

describe("argument validation (§12.4, AC-10)", () => {
  const schema = findTool("fs.read")!.parameters;

  test("structured edit requires scope identity and path-bearing operations", () => {
    const editSchema = findTool("fs.edit")!.parameters;
    const plan = {
      schemaVersion: "1.0",
      id: "edp_1",
      source: "model",
      workspaceIdentityDigest: "ws_1",
      sessionId: "ses_1",
      operations: [{ operationId: "edo_1", kind: "replace_range", path: "src/a.ts" }],
      conflictPolicy: "fail",
      createdAt: "2026-08-25T00:00:00.000Z",
    };
    // Anchor/range-specific fields are checked again by the Rust authority.
    expect(parseAndValidate(JSON.stringify({ plan }), editSchema).ok).toBe(true);
    expect(parseAndValidate(JSON.stringify({
      plan: { ...plan, workspaceIdentityDigest: "" },
    }), editSchema).ok).toBe(false);
    expect(parseAndValidate(JSON.stringify({
      plan: {
        ...plan,
        operations: [{ operationId: "edo_1", kind: "replace_range", path: "" }],
      },
    }), editSchema).ok).toBe(false);
  });

  test("artifact.read accepts digests and displayed handles but rejects mixed junk", () => {
    const artifactSchema = findTool("artifact.read")!.parameters;
    const digest = "a".repeat(64);
    for (const locator of [digest, "sha256:" + digest, "art_" + digest.slice(0, 24), "art_" + digest]) {
      expect(parseAndValidate(JSON.stringify({ digest: locator }), artifactSchema).ok).toBe(true);
    }
    for (const locator of ["art_missing", "../" + digest, "a".repeat(63)]) {
      expect(parseAndValidate(JSON.stringify({ digest: locator }), artifactSchema).ok).toBe(false);
    }
  });

  test("accepts a valid call and applies defaults", () => {
    const result = parseAndValidate('{"path":"src/a.ts"}', schema);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      path: "src/a.ts",
      startLine: 1,
      maxLines: 400,
      mode: "exact",
      allowAbsolute: false,
    });
  });

  test("exposes preview/exact and byte bounds without changing the legacy read shape", () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.mode?.enum).toEqual(["preview", "exact"]);
    expect(properties.mode?.default).toBe("exact");
    expect(properties.maxBytes?.type).toBe("integer");
    expect(parseAndValidate('{"path":"src/a.ts","mode":"preview","maxBytes":4096}', schema).ok).toBe(true);
  });

  test("read_many accepts independently ranged items and aggregate limits", () => {
    const readMany = findTool("fs.read_many")!;
    const properties = readMany.parameters.properties as Record<string, Record<string, unknown>>;
    expect(properties.items?.type).toBe("array");
    expect(properties.maxTotalLines?.type).toBe("integer");
    expect(properties.maxTotalBytes?.type).toBe("integer");
    expect(properties.concurrency?.type).toBe("integer");
    const result = parseAndValidate(JSON.stringify({
      items: [{ path: "src/a.ts", startLine: 10, maxLines: 5, mode: "preview", maxBytes: 4096 }],
      maxTotalLines: 5,
      concurrency: 1,
    }), readMany.parameters);
    expect(result.ok).toBe(true);
  });

  test("rejects malformed JSON without executing (AC-10)", () => {
    const result = parseAndValidate('{"path": "src/a.ts"', schema);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain("not valid JSON");
  });

  test("rejects a missing required property", () => {
    const result = parseAndValidate("{}", schema);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === "path" && e.message === "is required")).toBe(true);
  });

  test("rejects an unexpected property (§12.4)", () => {
    const result = parseAndValidate('{"path":"a","sudo":true}', schema);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === "sudo")).toBe(true);
  });

  test("rejects a wrong type", () => {
    const result = parseAndValidate('{"path":123}', schema);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain("must be a string");
  });

  test("enforces numeric bounds", () => {
    const runSchema = findTool("process.run")!.parameters;
    const tooLong = parseAndValidate('{"program":"sleep","timeoutMs":99999999}', runSchema);
    expect(tooLong.ok).toBe(false);
    expect(tooLong.errors.some((e) => e.message.includes("must be <="))).toBe(true);

    const tooShort = parseAndValidate('{"program":"sleep","timeoutMs":1}', runSchema);
    expect(tooShort.ok).toBe(false);
    expect(tooShort.errors.some((e) => e.message.includes("must be >="))).toBe(true);
  });

  test("enforces string length limits", () => {
    const result = parseAndValidate(
      JSON.stringify({ path: "a".repeat(5000) }),
      schema,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain("at most 4096");
  });

  test("enforces enum values", () => {
    const writeSchema = findTool("fs.write")!.parameters;
    const result = parseAndValidate('{"path":"a","content":"x","intent":"obliterate"}', writeSchema);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("must be one of"))).toBe(true);
  });

  test("validates array items and bounds", () => {
    const spawnSchema = findTool("task.spawn")!.parameters;
    const result = parseAndValidate(
      JSON.stringify({
        role: "executor",
        title: "T",
        goal: "a goal long enough to pass",
        constraints: [],
        expectedOutput: ["x"],
      }),
      spawnSchema,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("at least 1 item"))).toBe(true);
  });

  test("validates nested array element types", () => {
    const result = parseAndValidate(
      '{"paths":["ok",42]}',
      findTool("fs.read_many")!.parameters,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path.includes("[1]"))).toBe(true);
  });

  test("empty arguments are treated as an empty object", () => {
    const result = parseAndValidate("", findTool("git.status")!.parameters);
    expect(result.ok).toBe(true);
  });

  test("rejects a top-level array or scalar", () => {
    expect(parseAndValidate("[1,2]", schema).ok).toBe(false);
    expect(parseAndValidate('"string"', schema).ok).toBe(false);
    expect(parseAndValidate("null", schema).ok).toBe(false);
  });

  test("open additionalProperties is honoured where declared", () => {
    const result = parseAndValidate(
      '{"server":"gh","tool":"list_issues","arguments":{"anything":1,"nested":{"deep":true}}}',
      findTool("mcp.call")!.parameters,
    );
    expect(result.ok).toBe(true);
  });

  test("renders a model-facing observation (AC-10)", () => {
    const result = parseAndValidate('{"nope":1}', schema);
    const rendered = renderValidationErrors("fs.read", result.errors);
    expect(rendered).toContain("INVALID_ARGUMENT: fs.read was not executed");
    expect(rendered).toContain("Re-issue the call with corrected arguments.");
  });

  test("a schema without a declared type is reported, not silently allowed", () => {
    const result = validate({ a: 1 }, { type: "object", properties: { a: {} }, required: [], additionalProperties: false });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain("no declared type");
  });
});

describe("discovery ranking (§6.9, AC-09)", () => {
  test("finds subagent tools for a delegation query", () => {
    const result = discover(NATIVE_TOOLS, "sub-agent delegation executor agent task runner");
    const top = result.matches.slice(0, 3).map((m) => m.toolId);
    expect(top).toContain("task.spawn");
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.totalCount).toBe(NATIVE_TOOLS.length);
  });

  test("finds task search and spawn tools for a Korean delegation query", () => {
    const result = discover(
      NATIVE_TOOLS,
      "\uC11C\uBE0C \uC5D0\uC774\uC804\uD2B8 \uB610\uB294 \uD558\uC704 \uC791\uC5C5\uC744 \uC704\uD574 \uCF54\uB4DC\uBCA0\uC774\uC2A4\uB97C \uBD84\uC11D\uD558\uB294 \uB3C4\uAD6C",
    );
    expect(result.matches.map((match) => match.toolId)).toEqual(
      expect.arrayContaining(["task.search", "task.spawn"]),
    );
    expect(result.activated).toEqual(
      expect.arrayContaining(["task.search", "task.spawn"]),
    );
  });
  test("scores are ranks, not confidences, and are deterministic (§6.9)", () => {
    const a = rankTools(NATIVE_TOOLS, "run the tests");
    const b = rankTools(NATIVE_TOOLS, "run the tests");
    expect(a).toEqual(b);
    expect(a[0]!.score).toBeGreaterThan(1);
    // A rank may exceed 1, which a confidence never would.
    expect(Math.max(...a.map((m) => m.score))).toBeGreaterThan(1);
  });

  test("respects the activation limit (§21.4)", () => {
    const result = discover(NATIVE_TOOLS, "file read write search patch run git task skill mcp", {
      limit: 4,
    });
    expect(result.activated.length).toBeLessThanOrEqual(4);
    expect(result.limit).toBe(4);
  });

  test("counts already-active tools against the limit", () => {
    const result = discover(NATIVE_TOOLS, "git diff log show", {
      limit: 3,
      alreadyActive: ["fs.read", "fs.search"],
    });
    expect(result.activeCount).toBeLessThanOrEqual(3);
    expect(result.activated).not.toContain("fs.read");
  });

  test("a permission filter hides tools a read-only agent may not use", () => {
    const result = discover(NATIVE_TOOLS, "write a file and patch it", {
      permitted: (tool) => !tool.mutates,
    });
    expect(result.matches.map((m) => m.toolId)).not.toContain("fs.write");
    expect(result.matches.map((m) => m.toolId)).not.toContain("fs.apply_patch");
  });

  test("an empty query matches nothing rather than everything", () => {
    expect(discover(NATIVE_TOOLS, "   ").matches).toHaveLength(0);
  });

  test("matches Korean query tokens", () => {
    // The tokenizer keeps Hangul so a mixed-language query still ranks.
    const result = rankTools(NATIVE_TOOLS, "파일 read 검색");
    expect(result.length).toBeGreaterThan(0);
  });

  test("renders the §6.9 block shape", () => {
    const result = discover(NATIVE_TOOLS, "sub-agent delegation executor agent task runner", {
      limit: 10,
    });
    const lines = renderDiscoveryBlock(result);
    expect(lines[0]).toContain("✓ Tool Discovery:");
    expect(lines[1]).toContain("matches ·");
    expect(lines[1]).toContain("active ·");
    expect(lines[1]).toContain("total · limit:10");
    expect(lines.some((l) => l.startsWith("├─") || l.startsWith("└─"))).toBe(true);
    expect(lines.some((l) => l.includes("score "))).toBe(true);
  });

  test("the block can be rendered without icons for NO_COLOR (AC-45)", () => {
    const lines = renderDiscoveryBlock(discover(NATIVE_TOOLS, "read a file"), { icons: false });
    expect(lines[0]?.startsWith("Tool Discovery:")).toBe(true);
  });
});

describe("registry activation (AC-09)", () => {
  test("always-active tools start active", () => {
    const registry = new ToolRegistry();
    const active = registry.activeIds();
    expect(active).toContain("fs.read");
    expect(active).not.toContain("task.spawn");
  });

  test("Build-mode todo.write does not offer the structured Plan Contract field", () => {
    const registry = new ToolRegistry();
    const buildTool = registry.activeToolsFor("build").find((tool) => tool.id === "todo.write");
    const planTool = registry.activeToolsFor("plan").find((tool) => tool.id === "todo.write");

    expect(buildTool).toBeDefined();
    expect(planTool).toBeDefined();
    const buildProperties = buildTool!.parameters.properties as Record<string, unknown>;
    const planProperties = planTool!.parameters.properties as Record<string, unknown>;
    expect(buildProperties.document).toBeUndefined();
    expect(planProperties.document).toBeDefined();
    expect(buildTool!.description).toContain("ordinary TODO items only");
  });

  test("discovery activates schemas for the next sampling step", () => {
    const registry = new ToolRegistry();
    expect(registry.activeIds()).not.toContain("task.spawn");
    const result = registry.discover("spawn a subagent to explore in parallel");
    expect(result.activated).toContain("task.spawn");
    expect(registry.activeIds()).toContain("task.spawn");
  });

  test("calling an inactive tool is rejected before execution", () => {
    const registry = new ToolRegistry();
    const result = registry.validateCall("task.spawn", "{}");
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain("not active");
  });

  test("an unknown tool is rejected", () => {
    const registry = new ToolRegistry();
    expect(registry.validateCall("fs.obliterate", "{}").ok).toBe(false);
  });

  test("dynamic Skill and MCP tools use the same registry (§6.9)", () => {
    const registry = new ToolRegistry();
    const before = registry.size;
    registry.register({
      id: "mcp.github.create_issue",
      title: "CreateIssue",
      description: "Create a GitHub issue",
      source: "mcp",
      defaultRisk: "R6",
      maxRisk: "R6",
      alwaysActive: false,
      mutates: false,
      network: true,
      keywords: ["github", "issue", "create", "ticket"],
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    });
    expect(registry.size).toBe(before + 1);
    const result = registry.discover("create a github issue");
    expect(result.matches.map((m) => m.toolId)).toContain("mcp.github.create_issue");
    expect(result.matches.find((m) => m.toolId === "mcp.github.create_issue")?.source).toBe("mcp");
  });

  test("unregistering a source removes its tools", () => {
    const registry = new ToolRegistry();
    registry.register({
      id: "mcp.x.y",
      title: "Y",
      description: "y",
      source: "mcp",
      defaultRisk: "R1",
      maxRisk: "R6",
      alwaysActive: true,
      mutates: false,
      network: true,
      keywords: [],
      parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    });
    expect(registry.activeIds()).toContain("mcp.x.y");
    expect(registry.unregisterSource("mcp")).toBe(1);
    expect(registry.has("mcp.x.y")).toBe(false);
    expect(registry.activeIds()).not.toContain("mcp.x.y");
  });

  test("resetting activation restores only always-active tools", () => {
    const registry = new ToolRegistry();
    registry.discover("spawn a subagent");
    expect(registry.activeIds()).toContain("task.spawn");
    registry.resetActivation();
    expect(registry.activeIds()).not.toContain("task.spawn");
    expect(registry.activeIds()).toContain("fs.read");
  });

  test("the activation limit budgets discovered tools, not the baseline (R-08)", () => {
    // The always-active baseline is larger than the default limit of 10, so a
    // naive budget would make discovery a no-op and hide required tools.
    const registry = new ToolRegistry();
    const baseline = registry.activeIds().length;
    expect(baseline).toBeGreaterThan(5);

    const result = registry.discover("spawn a subagent and call an mcp tool", { limit: 2 });
    expect(result.activated.length).toBeGreaterThan(0);
    expect(result.activated.length).toBeLessThanOrEqual(2);
    // activeCount reports the true total, baseline included (§6.9).
    expect(result.activeCount).toBe(baseline + result.activated.length);
  });

  test("repeated discovery accumulates up to the limit and then stops", () => {
    const registry = new ToolRegistry();
    const first = registry.discover("spawn a subagent", { limit: 2 });
    const second = registry.discover("call an mcp tool on a server", { limit: 2 });
    const third = registry.discover("load a skill", { limit: 2 });
    const total = first.activated.length + second.activated.length + third.activated.length;
    expect(total).toBeLessThanOrEqual(2);
  });

  test("active schemas contain no provider-specific object (TOOL-005)", () => {
    const registry = new ToolRegistry();
    const serialized = JSON.stringify(registry.activeTools());
    // Provider wire shapes that must never leak into the tool contract.
    for (const forbidden of [
      "openai",
      "prompt_cache",
      "output_text",
      "function_call_output",
      "encrypted_content",
      "response.completed",
      "finish_reason",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("scheduler (§12.9)", () => {
  const catalog = NATIVE_TOOLS;

  function call(callId: string, toolId: string, extra: Partial<ProposedCall> = {}): ProposedCall {
    return { callId, toolId, arguments: {}, ...extra };
  }

  test("batches parallel reads, then a single writer, then verification", () => {
    const plan = schedule(
      [
        call("1", "fs.read", { reads: ["a.ts"] }),
        call("2", "fs.read", { reads: ["b.ts"] }),
        call("3", "fs.search"),
        call("4", "fs.apply_patch", { writes: ["a.ts"] }),
        call("5", "process.run"),
        call("6", "git.diff"),
      ],
      { catalog, agentId: "root", callsUsed: 0 },
    );
    expect(plan.rejected).toEqual([]);
    const kinds = plan.batches.map((b) => b.kind);
    expect(kinds.indexOf("read")).toBeLessThan(kinds.indexOf("write"));
    expect(kinds.indexOf("write")).toBeLessThan(kinds.indexOf("process"));
    const writeBatch = plan.batches.find((b) => b.kind === "write")!;
    expect(writeBatch.calls).toHaveLength(1);
  });

  test("serializes multiple writes one per batch (§12.9)", () => {
    const plan = schedule(
      [
        call("1", "fs.write", { writes: ["a.ts"] }),
        call("2", "fs.write", { writes: ["b.ts"] }),
      ],
      { catalog, agentId: "root", callsUsed: 0 },
    );
    const writeBatches = plan.batches.filter((b) => b.kind === "write");
    expect(writeBatches).toHaveLength(2);
    expect(writeBatches.every((b) => b.calls.length === 1)).toBe(true);
  });

  test("rejects overlapping writes in one turn (§T2)", () => {
    const plan = schedule(
      [
        call("1", "fs.write", { writes: ["src/a.ts"] }),
        call("2", "fs.apply_patch", { writes: ["src/a.ts"] }),
      ],
      { catalog, agentId: "root", callsUsed: 0 },
    );
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.code).toBe("PATH_OVERLAP");
    expect(plan.rejected[0]?.message).toContain("re-read before writing again");
  });

  test("only the lease owner may write (AC-23, SUB-003)", () => {
    const lease = createLease({
      leaseId: "l1",
      ownerAgentId: "executor-1",
      pathGlobs: ["scripts/**"],
      baseline: [],
      ttlMs: 60_000,
    });
    const denied = schedule([call("1", "fs.write", { writes: ["scripts/demo.py"] })], {
      catalog,
      agentId: "root",
      callsUsed: 0,
      writerLease: lease,
    });
    expect(denied.rejected[0]?.code).toBe("LEASE_VIOLATION");
    expect(denied.rejected[0]?.message).toContain("held by 'executor-1'");

    const allowed = schedule([call("1", "fs.write", { writes: ["scripts/demo.py"] })], {
      catalog,
      agentId: "executor-1",
      callsUsed: 0,
      writerLease: lease,
    });
    expect(allowed.rejected).toEqual([]);
  });

  test("a write outside the lease scope is rejected (AC-24)", () => {
    const lease = createLease({
      leaseId: "l1",
      ownerAgentId: "executor-1",
      pathGlobs: ["scripts/demo.py"],
      baseline: [],
      ttlMs: 60_000,
    });
    const plan = schedule([call("1", "fs.write", { writes: ["README.md"] })], {
      catalog,
      agentId: "executor-1",
      callsUsed: 0,
      writerLease: lease,
    });
    expect(plan.rejected[0]?.code).toBe("LEASE_VIOLATION");
    expect(plan.rejected[0]?.message).toContain("README.md");
  });

  test("reads are unaffected by the lease", () => {
    const lease = createLease({
      leaseId: "l1",
      ownerAgentId: "executor-1",
      pathGlobs: ["scripts/**"],
      baseline: [],
      ttlMs: 60_000,
    });
    const plan = schedule([call("1", "fs.read", { reads: ["README.md"] })], {
      catalog,
      agentId: "root",
      callsUsed: 0,
      writerLease: lease,
    });
    expect(plan.rejected).toEqual([]);
  });

  test("enforces the per-turn tool call budget (§11.3)", () => {
    const calls = Array.from({ length: 5 }, (_, i) => call(String(i), "fs.read"));
    const plan = schedule(calls, {
      catalog,
      agentId: "root",
      callsUsed: DEFAULT_SCHEDULER_LIMITS.maxToolCallsPerTurn - 2,
    });
    expect(plan.rejected.filter((r) => r.code === "BUDGET_EXHAUSTED")).toHaveLength(3);
  });

  test("caps process concurrency at the §14.7 default", () => {
    const calls = Array.from({ length: 9 }, (_, i) => call(String(i), "process.run"));
    const plan = schedule(calls, { catalog, agentId: "root", callsUsed: 0 });
    for (const batch of plan.batches.filter((b) => b.kind === "process")) {
      expect(batch.calls.length).toBeLessThanOrEqual(4);
    }
  });

  test("bounds MCP concurrency per server (§17.3)", () => {
    const calls = [
      call("1", "mcp.call", { mcpServer: "github" }),
      call("2", "mcp.call", { mcpServer: "github" }),
      call("3", "mcp.call", { mcpServer: "github" }),
      call("4", "mcp.call", { mcpServer: "docs" }),
    ];
    const plan = schedule(calls, { catalog, agentId: "root", callsUsed: 0 });
    const external = plan.batches.filter((b) => b.kind === "external");
    for (const batch of external) expect(batch.calls.length).toBeLessThanOrEqual(2);
    expect(external.some((b) => b.barrier.includes("github"))).toBe(true);
    expect(external.some((b) => b.barrier.includes("docs"))).toBe(true);
  });

  test("rejects an unknown tool", () => {
    const plan = schedule([call("1", "fs.nuke")], { catalog, agentId: "root", callsUsed: 0 });
    expect(plan.rejected[0]?.code).toBe("UNKNOWN_TOOL");
  });

  test("user.ask is its own serialized batch", () => {
    const plan = schedule([call("1", "user.ask"), call("2", "fs.read")], {
      catalog,
      agentId: "root",
      callsUsed: 0,
    });
    const interactive = plan.batches.filter((b) => b.kind === "interactive");
    expect(interactive).toHaveLength(1);
    expect(interactive[0]?.calls).toHaveLength(1);
  });
});

describe("writer lease (§15.8)", () => {
  test("expiry is enforced", () => {
    const lease = createLease({
      leaseId: "l",
      ownerAgentId: "a",
      pathGlobs: ["**"],
      baseline: [],
      ttlMs: 1_000,
      now: 0,
    });
    expect(leaseExpired(lease, 500)).toBe(false);
    expect(leaseExpired(lease, 1_500)).toBe(true);
  });

  test("reconciliation separates agent writes from external edits", () => {
    const lease = createLease({
      leaseId: "l",
      ownerAgentId: "a",
      pathGlobs: ["**"],
      baseline: [
        { path: "a.ts", hash: "h1" },
        { path: "b.ts", hash: "h2" },
        { path: "c.ts", hash: "h3" },
      ],
      ttlMs: 60_000,
    });
    const result = reconcileLease(
      lease,
      [
        { path: "a.ts", hash: "h1-new" },
        { path: "b.ts", hash: "h2-external" },
        { path: "c.ts", hash: "h3" },
      ],
      ["a.ts"],
    );
    expect(result.changed).toEqual(["a.ts"]);
    expect(result.conflicted).toEqual(["b.ts"]);
    expect(result.unchanged).toEqual(["c.ts"]);
  });
});

describe("glob matcher", () => {
  test("single star does not cross a separator", () => {
    expect(globMatch("*.ts", "a.ts")).toBe(true);
    expect(globMatch("*.ts", "src/a.ts")).toBe(false);
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/deep/a.ts")).toBe(false);
  });

  test("double star crosses separators", () => {
    expect(globMatch("**", "any/deep/path.ts")).toBe(true);
    expect(globMatch("src/**", "src/a/b.ts")).toBe(true);
    expect(globMatch("src/**", "src/b.ts")).toBe(true);
    expect(globMatch("src/**", "lib/b.ts")).toBe(false);
  });

  test("question mark matches one non-separator character", () => {
    expect(globMatch("?.ts", "a.ts")).toBe(true);
    expect(globMatch("?.ts", "ab.ts")).toBe(false);
  });

  test("exact patterns are exact", () => {
    expect(globMatch("scripts/demo.py", "scripts/demo.py")).toBe(true);
    expect(globMatch("scripts/demo.py", "scripts/demo.pyc")).toBe(false);
  });
});

describe("result envelope (§12.4, TOOL-005, TOOL-006)", () => {
  test("ok results carry a summary", () => {
    const result = okResult("4 matches in 3 files", { matches: 4 });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("4 matches in 3 files");
    expect(result.error).toBeUndefined();
  });

  test("error results carry a taxonomy code and retryability", () => {
    const result = errorResult("PATH_OUTSIDE_WORKSPACE", "denied", { retryable: false });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
    expect(result.error?.retryable).toBe(false);
    expect(result.summary).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  test("results can carry both an artifact and a summary (TOOL-006)", () => {
    const result = okResult("128 passed · 1 failed", undefined, {
      artifacts: [
        {
          id: "art_abc",
          digest: "d".repeat(64),
          mediaType: "text/plain",
          bytes: 4_000_000,
          redaction: "redacted",
          retentionClass: "session",
        },
      ],
      warnings: ["output truncated"],
    });
    expect(result.artifacts).toHaveLength(1);
    expect(result.summary).toContain("128 passed");
    // The artifact reference exposes an opaque id, not a path (§18.17).
    expect(result.artifacts![0]!.id.startsWith("art_")).toBe(true);
  });
});
