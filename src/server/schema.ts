// Shared by runtime schema initialization and the explicit operational importer.
export const ADMIN_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS overrides (event_id TEXT PRIMARY KEY, image TEXT, schedule TEXT, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS login_failures (bucket TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS login_failures_bucket_at ON login_failures (bucket, at)",
  "CREATE TABLE IF NOT EXISTS stage (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL, staged_at TEXT)",
  "INSERT OR IGNORE INTO stage (singleton, revision, staged_at) SELECT 1, CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END, MAX(updated_at) FROM overrides",
  "CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('queued', 'building', 'published', 'failed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, snapshot TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS publications_one_active ON publications ((1)) WHERE state IN ('queued', 'building')",
] as const;
export const CALENDAR_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS official_feeds (id TEXT PRIMARY KEY, generated_at TEXT NOT NULL, created_at TEXT NOT NULL, event_count INTEGER NOT NULL, manifest TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)))",
  "CREATE TABLE IF NOT EXISTS official_artifacts (feed_id TEXT NOT NULL, path TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(feed_id,path,part))",
  "CREATE TABLE IF NOT EXISTS official_event_meta (feed_id TEXT NOT NULL,event_id TEXT NOT NULL,kind TEXT NOT NULL,all_day INTEGER NOT NULL,PRIMARY KEY(feed_id,event_id))",
  "CREATE TABLE IF NOT EXISTS calendar_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1),feed_id TEXT NOT NULL,previous_feed_id TEXT,published_id TEXT)",
  "CREATE TABLE IF NOT EXISTS published_images (upload TEXT NOT NULL,publication_id TEXT NOT NULL,PRIMARY KEY(upload,publication_id))",
] as const;
