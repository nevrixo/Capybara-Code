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
  CapsuleStore,
  capsuleId,
  compareCapsules,
  freezeCapsule,
  type AcceptedCapsuleProposal,
  type CapsuleKind,
  type CapsuleProposalInput,
  type CapsuleProposalResult,
  type CapsuleScope,
  type CapsuleStatus,
  type CapsuleStoreOptions,
  type CapsuleStoreSnapshot,
  type CapsuleTransition,
  type RejectedCapsuleProposal,
  type StrategyCapsule,
} from "./capsule.ts";
