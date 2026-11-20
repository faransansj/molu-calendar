import { z } from "zod";
import type {
  ConversationMessage,
  QuoteReference,
  Reference,
} from "../chat/types.ts";
import { memoriesSchema, excerptsSchema } from "./persona.ts";
import {
  MOMO_HISTORY_TURNS,
  MOMO_MESSAGE_MAX,
  OUTPUT_RESERVE,
} from "../chat/prompt.ts";

export type LoadMode = "cache-only" | "download";

export interface WorkerPayloads {
  cache: object;
  delete: { modelId: string };
  load: { modelId: string; mode: LoadMode };
  generate: {
    messages: ConversationMessage[];
    maxTokens: number;
    characterId?: string;
    memories?: Reference[];
    excerpts?: QuoteReference[];
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
const conversationSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z
    .string()
    .min(1)
    .max(MOMO_MESSAGE_MAX)
    .refine((text) => !!text.trim()),
});
const requestId = z.number().int().positive();
const requestSchema = z.discriminatedUnion("action", [
  z.object({ id: requestId, action: z.literal("cache") }),
  z.object({
    id: requestId,
    action: z.literal("delete"),
    modelId: z.string(),
  }),
  z.object({
    id: requestId,
    action: z.literal("load"),
    modelId: z.string(),
    mode: z.enum(["cache-only", "download"]),
  }),
  z.object({
    id: requestId,
    action: z.literal("generate"),
    messages: z
      .array(conversationSchema)
      .min(1)
      .max(2 * MOMO_HISTORY_TURNS + 1)
      .refine(
        (messages) =>
          messages.length % 2 === 1 &&
          messages.every(
            ({ role }, i) => role === (i % 2 === 0 ? "user" : "assistant"),
          ),
      ),
    maxTokens: z.number().int().min(1).max(OUTPUT_RESERVE),
    characterId: z.string().optional(),
    memories: memoriesSchema.optional(),
    excerpts: excerptsSchema.optional(),
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
