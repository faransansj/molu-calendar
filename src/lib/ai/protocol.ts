import { z } from "zod";
import type { ConversationMessage, Reference } from "../chat/types.ts";

export interface WorkerPayloads {
  cache: object;
  delete: { modelId: string };
  load: { modelId: string };
  generate: {
    messages: ConversationMessage[];
    maxTokens: number;
    characterId?: string;
    memories?: Reference[];
    excerpts?: Reference[];
  };
}
export interface CacheResult {
  counts: Record<string, number>;
  bytes: Record<string, number>;
}
export interface GenerationResult {
  text: string;
  ttftMs: number;
  tokens?: number;
  tokensPerSecond?: number;
  elapsedMs: number;
}
export interface WorkerResults {
  cache: CacheResult;
  delete: CacheResult;
  load: { loadMs: number };
  generate: GenerationResult;
}
export type WorkerAction = keyof WorkerPayloads;
export type WorkerRequest = {
  [K in WorkerAction]: { id: number; action: K } & WorkerPayloads[K];
}[WorkerAction];
const referenceSchema = z.object({ id: z.string(), text: z.string() }).strict();
const conversationSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
const requestId = z.number().int().positive();
const requestSchema = z.discriminatedUnion("action", [
  z.object({ id: requestId, action: z.literal("cache") }),
  z.object({
    id: requestId,
    action: z.literal("delete"),
    modelId: z.string(),
  }),
  z.object({ id: requestId, action: z.literal("load"), modelId: z.string() }),
  z.object({
    id: requestId,
    action: z.literal("generate"),
    messages: z.array(conversationSchema),
    maxTokens: z.number(),
    characterId: z.string().optional(),
    memories: z.array(referenceSchema).optional(),
    excerpts: z.array(referenceSchema).optional(),
  }),
]);
export function parseWorkerRequest(value: unknown): WorkerRequest {
  return requestSchema.parse(value);
}
const eventSchema = z.object({
  id: requestId,
  event: z.enum(["started", "progress", "token", "trace"]),
  text: z.string().optional(),
  progress: z.number().optional(),
  characterId: z.string().optional(),
  messageChars: z.number().optional(),
  memories: z.number().optional(),
  excerpts: z.number().optional(),
  referenceChars: z.number().optional(),
  promptChars: z.number().optional(),
});
export type AIEvent = z.infer<typeof eventSchema>;
export type EventValue = Omit<AIEvent, "id" | "event">;
const replySchema = z.union([
  eventSchema,
  z.object({
    id: requestId,
    done: z.literal(true),
    error: z.object({ code: z.string().optional(), message: z.string() }),
  }),
  z.object({ id: requestId, done: z.literal(true), result: z.unknown() }),
]);
export function parseWorkerReply(value: unknown) {
  return replySchema.parse(value);
}
const cacheResultSchema = z.object({
  counts: z.record(z.string(), z.number()),
  bytes: z.record(z.string(), z.number()),
});
const resultSchemas = {
  cache: cacheResultSchema,
  delete: cacheResultSchema,
  load: z.object({ loadMs: z.number() }),
  generate: z.object({
    text: z.string(),
    ttftMs: z.number(),
    tokens: z.number().optional(),
    tokensPerSecond: z.number().optional(),
    elapsedMs: z.number(),
  }),
};
export function parseWorkerResult<K extends WorkerAction>(
  action: K,
  value: unknown,
): WorkerResults[K] {
  // The indexed schema and action share K; Zod cannot express this correlation.
  return resultSchemas[action].parse(value) as WorkerResults[K];
}
export interface RequestOptions {
  onEvent?: (event: AIEvent) => void;
  firstMs?: number;
  timeoutMs?: number;
  timeoutCode?: string;
}
export interface AIClient {
  request<K extends WorkerAction>(
    action: K,
    payload: WorkerPayloads[K],
    options?: RequestOptions,
  ): Promise<WorkerResults[K]>;
  stop(error?: unknown): void;
}
export interface CodedError extends Error {
  code?: string;
}
export function errorCode(error: unknown) {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
