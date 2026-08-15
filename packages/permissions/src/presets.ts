export type PermissionPreset = "read" | "edit" | "auto" | "yolo";

export interface PermissionPresetDefinition {
  readonly id: PermissionPreset;
  readonly label: string;
  readonly description: string;
  readonly dangerous: boolean;
  readonly policy: {
    readonly nativeRead: "allow";
    readonly nativeWrite: "deny" | "ask" | "allow";
    readonly process: "deny" | "risk" | "allow";
    readonly network: "deny" | "ask" | "allow";
    readonly destructive: "deny" | "ask" | "allow";
    readonly credentials: "deny" | "ask" | "allow";
    readonly externalSideEffect: "deny" | "ask" | "allow";
  };
}

const PRESET_DEFINITIONS: Record<PermissionPreset, PermissionPresetDefinition> = {
  read: {
    id: "read",
    label: "READ",
    description: "읽기 전용 — 파일을 분석하지만 수정하거나 명령을 실행하지 않음",
    dangerous: false,
    policy: {
      nativeRead: "allow",
      nativeWrite: "deny",
      process: "deny",
      network: "deny",
      destructive: "deny",
      credentials: "deny",
      externalSideEffect: "deny",
    },
  },
  edit: {
    id: "edit",
    label: "EDIT",
    description: "파일 편집 — 워크스페이스 파일은 수정 가능, 명령과 네트워크는 차단",
    dangerous: false,
    policy: {
      nativeRead: "allow",
      nativeWrite: "allow",
      process: "deny",
      network: "deny",
      destructive: "ask",
      credentials: "deny",
      externalSideEffect: "ask",
    },
  },
  auto: {
    id: "auto",
    label: "AUTO",
    description: "위험 작업만 확인 — 일반 편집과 안전한 명령은 자동, 위험 작업만 질문",
    dangerous: false,
    policy: {
      nativeRead: "allow",
      nativeWrite: "allow",
      process: "risk",
      network: "ask",
      destructive: "ask",
      credentials: "deny",
      externalSideEffect: "ask",
    },
  },
  yolo: {
    id: "yolo",
    label: "YOLO",
    description: "모든 승인 질문을 생략합니다. 신뢰, 명시적 차단 규칙, 샌드박스 및 OS 권한은 계속 적용됩니다.",
    dangerous: true,
    policy: {
      nativeRead: "allow",
      nativeWrite: "allow",
      process: "allow",
      network: "allow",
      destructive: "allow",
      credentials: "deny",
      externalSideEffect: "allow",
    },
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

export interface ResolvedPermissionPolicy {
  readonly preset: PermissionPreset | "custom";
  readonly policy: PermissionPresetDefinition["policy"];
}

export function resolvePermissionPolicy(
  preset: PermissionPreset | undefined,
  configPermissions?: {
    readonly projectWrite?: "plan" | "ask" | "auto";
    readonly shell?: "deny" | "ask" | "safe-auto";
    readonly network?: "deny" | "ask" | "allow";
    readonly destructive?: "deny" | "ask";
    readonly credentials?: "deny" | "ask";
    readonly externalSideEffect?: "deny" | "ask";
  },
): ResolvedPermissionPolicy {
  if (preset !== undefined && isPermissionPreset(preset)) {
    return { preset, policy: PRESET_DEFINITIONS[preset].policy };
  }
  const inferred = inferPermissionPresetFromConfig(configPermissions);
  if (inferred !== "custom") {
    return { preset: inferred, policy: PRESET_DEFINITIONS[inferred].policy };
  }
  return { preset: "custom", policy: inferPolicyFromConfig(configPermissions) };
}

function inferPolicyFromConfig(config?: {
  readonly projectWrite?: string;
  readonly shell?: string;
  readonly network?: string;
  readonly destructive?: string;
  readonly credentials?: string;
  readonly externalSideEffect?: string;
}): PermissionPresetDefinition["policy"] {
  if (!config) return PRESET_DEFINITIONS.auto.policy;
  return {
    nativeRead: "allow",
    nativeWrite: config.projectWrite === "plan" ? "deny" : config.projectWrite === "ask" ? "ask" : "allow",
    process: config.shell === "deny" ? "deny" : config.shell === "ask" ? "deny" : "risk",
    network: (config.network as PermissionPresetDefinition["policy"]["network"]) ?? "ask",
    destructive: (config.destructive as PermissionPresetDefinition["policy"]["destructive"]) ?? "ask",
    credentials: (config.credentials as PermissionPresetDefinition["policy"]["credentials"]) ?? "deny",
    externalSideEffect: (config.externalSideEffect as PermissionPresetDefinition["policy"]["externalSideEffect"]) ?? "ask",
  };
}

export function inferPermissionPreset(effectivePolicy: PermissionPresetDefinition["policy"]): PermissionPreset | "custom" {
  for (const id of allPermissionPresetIds()) {
    const def = PRESET_DEFINITIONS[id].policy;
    if (
      def.nativeRead === effectivePolicy.nativeRead &&
      def.nativeWrite === effectivePolicy.nativeWrite &&
      def.process === effectivePolicy.process &&
      def.network === effectivePolicy.network &&
      def.destructive === effectivePolicy.destructive &&
      def.credentials === effectivePolicy.credentials &&
      def.externalSideEffect === effectivePolicy.externalSideEffect
    ) {
      return id;
    }
  }
  return "custom";
}

export function inferPermissionPresetFromConfig(config?: {
  readonly projectWrite?: string;
  readonly shell?: string;
  readonly network?: string;
  readonly destructive?: string;
  readonly credentials?: string;
  readonly externalSideEffect?: string;
}): PermissionPreset | "custom" {
  return inferPermissionPreset(inferPolicyFromConfig(config));
}

export function legacyPermissionModeToPreset(mode: string): PermissionPreset | "custom" {
  switch (mode) {
    case "plan":
      return "read";
    case "auto":
    case "auto-review":
      return "auto";
    case "ask":
      return "custom";
    default:
      return "custom";
  }
}

export function normalizePermissionHeadlessPolicy(value: string): "deny-on-ask" | "allow-listed" | "fail-on-ask" {
  if (value === "deny") return "deny-on-ask";
  if (value === "fail") return "fail-on-ask";
  return value as "deny-on-ask" | "allow-listed" | "fail-on-ask";
}
