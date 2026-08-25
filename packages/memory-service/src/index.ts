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
