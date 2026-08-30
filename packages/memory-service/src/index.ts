/**
 * `@cbc/memory-service` — production facade over MemoryBank with durable
 * recall, secret rejection, workspace isolation, and context projection.
 */

export {
  MemoryService,
  MemoryWriteError,
  detectSecretShaped,
  memoryToContextItem,
  type MemoryContextItem,
  type MemoryInspectView,
  type MemoryRecallQuery,
  type MemoryServiceOptions,
  type MemoryServiceSnapshot,
} from "./service.ts";

export {
  APPROVAL_REQUIRED_SCOPES,
  CapsuleStore,
  DEFAULT_MIN_VERIFIED_OBSERVATIONS,
  MIN_VERIFIED_OBSERVATIONS_FLOOR,
  capsuleId,
  capsuleScopeRequiresApproval,
  compareCapsules,
  freezeCapsule,
  type AcceptedCapsuleProposal,
  type CapsuleActivated,
  type CapsuleActivationOptions,
  type CapsuleActivationRefused,
  type CapsuleActivationResult,
  type CapsuleInvalidationResult,
  type CapsuleInvalidationTrigger,
  type CapsuleKind,
  type CapsuleLearningPolicy,
  type CapsuleProposalInput,
  type CapsuleProposalResult,
  type CapsuleRecallOptions,
  type CapsuleScope,
  type CapsuleStatus,
  type CapsuleStoreOptions,
  type CapsuleStoreSnapshot,
  type CapsuleTransition,
  type RejectedCapsuleProposal,
  type StrategyCapsule,
} from "./capsule.ts";
