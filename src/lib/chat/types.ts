/** Persisted schema v2. Keep these names stable for existing databases and backups. */
export type SpeakerType = "user" | "character" | "app";
export type SourceKind = "user-input" | "model-output" | "script" | "app";
export type MessageStatus =
  "complete" | "pending" | "failed" | "cancelled" | "interrupted";
export interface RoomRecord {
  id: string;
  profileId: "local";
  characterId: string;
  participants: string[];
  nextSeq: number;
  revision: number;
  userMessageCount: number;
  lastMessageId: string | null;
}
export interface MessageRecord {
  id: string;
  profileId: "local";
  roomId: string;
  seq: number;
  speakerId: string;
  speakerType: SpeakerType;
  text: string;
  sourceKind: SourceKind;
  status: MessageStatus;
  createdAt: number;
  replyToMessageId: string | null;
}
export interface Memory {
  id: string;
  profileId: "local";
  roomId: string;
  text: string;
  sourceMessageId: string | null;
  sourceText: string | null;
  createdAt: number;
  updatedAt: number;
  enabled: boolean;
  expiresAt: number | null;
}
export interface ChatMessage {
  id: string;
  me: boolean;
  text: string;
  time: string;
  status: MessageStatus;
  speakerType: SpeakerType;
  sourceKind: SourceKind;
  createdAt: number;
}
export interface RoomCache {
  roomId: string;
  records: MessageRecord[];
  messages: ChatMessage[];
  hasMore: boolean;
  userMessageCount: number;
  revision: number;
}
export interface Summary {
  roomId: string;
  last: ChatMessage;
  userMessageCount: number;
  revision: number;
  activityAt: number;
}
export interface ChatBundle {
  format: "molu-chat-memory";
  version: 2;
  exportedAt: number;
  rooms: RoomRecord[];
  messages: MessageRecord[];
  memories: Memory[];
}
export interface StoreOptions {
  indexedDB?: IDBFactory;
  name?: string;
  onBlocked?: () => void;
}
export interface MessageDraft {
  roomId: string;
  id?: string;
  speakerType: SpeakerType;
  text: string;
  sourceKind: SourceKind;
  status?: MessageStatus;
  createdAt?: number;
}
export type MemoryDraft = Pick<Memory, "roomId" | "text"> &
  Partial<Omit<Memory, "roomId" | "text" | "profileId">>;
export type MemoryPatch = Partial<
  Pick<Memory, "text" | "enabled" | "expiresAt">
>;
export interface WriteCondition {
  expectedRevision?: number;
  expectedLastMessageId?: string;
}
export interface RecordCounts {
  rooms: number;
  messages: number;
  memories: number;
}
export interface Reference {
  id: string;
  text: string;
}
export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export type ConversationMessage = PromptMessage & {
  role: "user" | "assistant";
};
export interface PromptHistory {
  me: boolean;
  text: string;
  pending?: boolean;
}
