import { createHash } from "node:crypto";

export type PermissionPreset = "read" | "edit" | "auto" | "yolo";
export type PermissionAxis = "deny" | "ask" | "allow";
export type ProcessAxis = "deny" | "ask" | "risk" | "allow";

export interface PermissionPresetDefinition {
  readonly id: PermissionPreset;
  readonly label: string;
  readonly description: string;
  readonly dangerous: boolean;
  readonly policy: {
    readonly nativeRead: "allow";
    readonly nativeWrite: PermissionAxis;
    readonly process: ProcessAxis;
    readonly directProcess: ProcessAxis;
    readonly shellLike: PermissionAxis;
    readonly network: PermissionAxis;
    readonly destructive: PermissionAxis;
    readonly credentials: PermissionAxis;
    readonly externalSideEffect: PermissionAxis;
  };
}

const PRESET_DEFINITIONS: Record<PermissionPreset, PermissionPresetDefinition> = {
  read: {
    id: "read",
    label: "READ",
    description: "읽기 전용 — 파일을 분석하지만 수정하거나 명령을 실행하지 않음",
    dangerous: false,
    policy: { nativeRead: "allow", nativeWrite: "deny", process: "deny", directProcess: "deny", shellLike: "deny", network: "deny", destructive: "deny", credentials: "deny", externalSideEffect: "deny" },
  },
  edit: {
    id: "edit",
    label: "EDIT",
    description: "파일 편집 — 워크스페이스 파일은 수정 가능, 명령과 네트워크는 차단",
    dangerous: false,
    policy: { nativeRead: "allow", nativeWrite: "allow", process: "deny", directProcess: "deny", shellLike: "deny", network: "deny", destructive: "ask", credentials: "deny", externalSideEffect: "ask" },
  },
  auto: {
    id: "auto",
    label: "AUTO",
    description: "위험 작업만 확인 — 일반 편집과 안전한 명령은 자동, 위험 작업만 질문",
    dangerous: false,
    policy: { nativeRead: "allow", nativeWrite: "allow", process: "risk", directProcess: "risk", shellLike: "ask", network: "ask", destructive: "ask", credentials: "deny", externalSideEffect: "ask" },
  },
  yolo: {
    id: "yolo",
    label: "YOLO",
    description: "모든 승인 질문을 생략합니다. 신뢰, 명시적 차단 규칙, 샌드박스 및 OS 권한은 계속 적용됩니다.",
    dangerous: true,
    policy: { nativeRead: "allow", nativeWrite: "allow", process: "allow", directProcess: "allow", shellLike: "allow", network: "allow", destructive: "allow", credentials: "deny", externalSideEffect: "allow" },
  },
};

export function isPermissionPreset(value: string): value is PermissionPreset {
  return value === "read" || value === "edit" || value === "auto" || value === "yolo";
}

export function permissionPresetDefinition(id: PermissionPreset): PermissionPresetDefinition {
  return PRESET_DEFINITIONS[id];
}

export function describePermissionPreset(id: PermissionPreset): string {
  return PRESET_DEFINITIONS[id].description;
}

export function allPermissionPresets(): readonly PermissionPresetDefinition[] {
  return Object.values(PRESET_DEFINITIONS);
}

export function allPermissionPresetIds(): readonly PermissionPreset[] {
  return ["read", "edit", "auto", "yolo"] as const;
}

export interface PermissionPolicyAxes {
  readonly nativeRead: "allow";
  readonly nativeWrite: PermissionAxis;
  readonly directProcess: ProcessAxis;
  readonly shellLike: PermissionAxis;
  readonly network: PermissionAxis;
  readonly destructive: PermissionAxis;
  readonly credentials: PermissionAxis;
  readonly externalSideEffect: PermissionAxis;
}

export interface PermissionRestriction {
  readonly axis: keyof PermissionPolicyAxes;
  readonly from: string;
  readonly to: string;
  readonly source: string;
}

export type PermissionConfig = {
  readonly projectWrite?: "plan" | "ask" | "auto";
  readonly shell?: "deny" | "ask" | "safe-auto";
  readonly network?: "deny" | "ask" | "allow";
  readonly destructive?: "deny" | "ask";
  readonly credentials?: "deny" | "ask";
  readonly externalSideEffect?: "deny" | "ask";
};

export interface ResolvedPermissionPolicy {
  readonly selectedPreset?: PermissionPreset;
  readonly basePreset: PermissionPreset | "custom";
  readonly effectiveKind: PermissionPreset | "custom";
  readonly preset: PermissionPreset | "custom";
  readonly policy: PermissionPresetDefinition["policy"];
  readonly axes: PermissionPolicyAxes;
  readonly restrictions: readonly PermissionRestriction[];
  readonly digest: string;
}

const CUSTOM_ASK_POLICY: PermissionPresetDefinition["policy"] = {
  nativeRead: "allow", nativeWrite: "ask", process: "risk", directProcess: "risk", shellLike: "ask", network: "ask", destructive: "ask", credentials: "deny", externalSideEffect: "ask",
};

/** Resolve one complete policy for evaluator, status, and TUI presentation. */
export function resolvePermissionPolicy(preset: PermissionPreset | undefined, configPermissions?: PermissionConfig, legacyMode?: string): ResolvedPermissionPolicy {
  const selectedPreset = preset !== undefined && isPermissionPreset(preset) ? preset : undefined;
  const legacyPreset = selectedPreset === undefined && legacyMode !== undefined ? legacyPermissionModeToPreset(legacyMode) : undefined;
  const inferred = selectedPreset === undefined && legacyPreset === undefined && configPermissions !== undefined ? inferPermissionPresetFromConfig(configPermissions) : undefined;
  const basePreset = selectedPreset ?? legacyPreset ?? inferred ?? "custom";
  const basePolicy = basePreset === "custom"
    ? legacyMode === "ask" || legacyPreset === "custom" || configPermissions === undefined ? CUSTOM_ASK_POLICY : inferPolicyFromConfig(configPermissions)
    : PRESET_DEFINITIONS[basePreset].policy;
  const { policy, restrictions } = applyPermissionRestrictions(basePolicy, configPermissions, basePreset === "yolo");
  const effectiveKind = basePreset !== "custom" && restrictions.length === 0 ? basePreset : "custom";
  const axes: PermissionPolicyAxes = { nativeRead: policy.nativeRead, nativeWrite: policy.nativeWrite, directProcess: policy.directProcess, shellLike: policy.shellLike, network: policy.network, destructive: policy.destructive, credentials: policy.credentials, externalSideEffect: policy.externalSideEffect };
  const digest = policyDigest({ basePreset, effectiveKind, axes, restrictions });
  return { ...(selectedPreset === undefined ? {} : { selectedPreset }), basePreset, effectiveKind, preset: effectiveKind, policy, axes, restrictions, digest };
}

function inferPolicyFromConfig(config?: PermissionConfig): PermissionPresetDefinition["policy"] {
  if (!config) return PRESET_DEFINITIONS.auto.policy;
  return { nativeRead: "allow", nativeWrite: config.projectWrite === "plan" ? "deny" : config.projectWrite === "ask" ? "ask" : "allow", process: config.shell === "deny" ? "deny" : config.shell === "ask" ? "deny" : "risk", directProcess: config.shell === "deny" ? "deny" : config.shell === "ask" ? "deny" : "risk", shellLike: config.shell === "deny" ? "deny" : "ask", network: config.network ?? "ask", destructive: config.destructive ?? "ask", credentials: config.credentials ?? "deny", externalSideEffect: config.externalSideEffect ?? "ask" };
}

function axisRank(value: PermissionAxis | ProcessAxis): number {
  if (value === "deny") return 0;
  if (value === "ask") return 1;
  if (value === "risk") return 2;
  return 3;
}

function applyPermissionRestrictions(
  base: PermissionPresetDefinition["policy"],
  config?: PermissionConfig,
  yoloSoftOverride = false,
): { policy: PermissionPresetDefinition["policy"]; restrictions: PermissionRestriction[] } {
  const next: PermissionPresetDefinition["policy"] = { ...base };
  const restrictions: PermissionRestriction[] = [];
  const set = <K extends keyof PermissionPresetDefinition["policy"]>(
    axis: K,
    value: PermissionPresetDefinition["policy"][K],
    source: string,
  ): void => {
    const from = next[axis];
    if (from === value) return;
    // Configuration is a monotonic ceiling: it may narrow a preset, never
    // loosen READ/credential protections. YOLO ignores soft "ask" overlays;
    // explicit deny values still remain hard boundaries.
    if (axis === "nativeRead") return;
    if (axisRank(value as PermissionAxis | ProcessAxis) >= axisRank(from as PermissionAxis | ProcessAxis)) return;
    next[axis] = value;
    restrictions.push({ axis: axis as keyof PermissionPolicyAxes, from: String(from), to: String(value), source });
  };
  if (config?.projectWrite === "plan") {
    set("nativeWrite", "deny", "projectWrite");
    set("directProcess", "deny", "projectWrite");
    set("process", "deny", "projectWrite");
  } else if (config?.projectWrite === "ask" && !yoloSoftOverride) {
    set("nativeWrite", "ask", "projectWrite");
    set("directProcess", "ask", "projectWrite");
    set("process", "ask", "projectWrite");
  }
  if (config?.shell === "deny") set("shellLike", "deny", "shell");
  else if (config?.shell === "ask" && !yoloSoftOverride) set("shellLike", "ask", "shell");
  if (config?.network === "deny" || (config?.network === "ask" && !yoloSoftOverride)) set("network", config.network, "network");
  if (config?.destructive === "deny" || (config?.destructive === "ask" && !yoloSoftOverride)) set("destructive", config.destructive, "destructive");
  if (config?.credentials === "deny" || (config?.credentials === "ask" && !yoloSoftOverride)) set("credentials", config.credentials, "credentials");
  if (config?.externalSideEffect === "deny" || (config?.externalSideEffect === "ask" && !yoloSoftOverride)) set("externalSideEffect", config.externalSideEffect, "externalSideEffect");
  return { policy: next, restrictions };
}

export function inferPermissionPreset(effectivePolicy: PermissionPresetDefinition["policy"]): PermissionPreset | "custom" {
  for (const id of allPermissionPresetIds()) {
    const def = PRESET_DEFINITIONS[id].policy;
    if (def.nativeRead === effectivePolicy.nativeRead && def.nativeWrite === effectivePolicy.nativeWrite && def.process === effectivePolicy.process && def.directProcess === effectivePolicy.directProcess && def.shellLike === effectivePolicy.shellLike && def.network === effectivePolicy.network && def.destructive === effectivePolicy.destructive && def.credentials === effectivePolicy.credentials && def.externalSideEffect === effectivePolicy.externalSideEffect) return id;
  }
  return "custom";
}

export function inferPermissionPresetFromConfig(config?: PermissionConfig): PermissionPreset | "custom" {
  return inferPermissionPreset(inferPolicyFromConfig(config));
}

export function legacyPermissionModeToPreset(mode: string): PermissionPreset | "custom" {
  switch (mode) { case "plan": return "read"; case "auto": case "auto-review": return "auto"; case "ask": return "custom"; default: return "custom"; }
}

export function normalizePermissionHeadlessPolicy(value: string): "deny-on-ask" | "allow-listed" | "fail-on-ask" {
  if (value === "deny") return "deny-on-ask";
  if (value === "fail") return "fail-on-ask";
  return value as "deny-on-ask" | "allow-listed" | "fail-on-ask";
}

export function describeEffectivePermissionPolicy(policy: ResolvedPermissionPolicy): string[] {
  const selected = policy.selectedPreset?.toUpperCase() ?? "CUSTOM";
  const effective = policy.effectiveKind.toUpperCase();
  const lines = [`Selected    ${selected}`, `Effective   ${effective}${policy.basePreset !== policy.effectiveKind ? ` (base ${policy.basePreset.toUpperCase()})` : ""}`, `Policy      ${policy.digest}`, `Files       ${policy.axes.nativeWrite}`, `Direct cmd  ${policy.axes.directProcess}`, `Shell       ${policy.axes.shellLike}`, `Network     ${policy.axes.network}`, `Destructive ${policy.axes.destructive}`, `Credentials ${policy.axes.credentials}`, `External    ${policy.axes.externalSideEffect}`];
  if (policy.restrictions.length > 0) { lines.push("Restrictions"); for (const restriction of policy.restrictions) lines.push(`  ${restriction.axis}: ${restriction.from} → ${restriction.to} (${restriction.source})`); }
  return lines;
}

function policyDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])]));
  return value;
}
