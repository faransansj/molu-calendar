import type { EventOverride } from "./overrides.ts";

export type PublicationState = "queued" | "building" | "published" | "failed";
export interface Publication {
  id: string;
  revision: number;
  state: PublicationState;
  created_at: string;
  updated_at: string;
}
export interface PublicationSnapshot {
  publication: Publication;
  overrides: EventOverride[];
}
export interface PublicationStatus {
  revision: number;
  staged_at: string | null;
  latest: Publication | null;
  deployed: Publication | null;
}
export const PUBLICATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PublishedManifest {
  publication: Pick<Publication, "id" | "revision"> | null;
  overrides: EventOverride[];
}
