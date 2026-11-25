-- Migration: 0002_create_storage_tables
-- Target database: storage (D1)
-- Description: Creates the "artificial-intelligence" table (deleted /
-- censored conversation IDs) and the files table (MEGA-backed file
-- metadata — files.id is the MEGA node ID referenced by attachments_id).
--
-- Apply with:
--   wrangler d1 execute storage --file=./migrations/0002_create_storage_tables.sql

-- Conversations IA supprimées ou censurées.
-- status: 'deleted' | 'censored'
CREATE TABLE IF NOT EXISTS "artificial-intelligence" (
  conversation_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'deleted',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_status ON "artificial-intelligence"(status);

-- Fichiers stockés sur MEGA (via mega-client-worker).
-- id = MEGA node ID — c'est cette valeur qui est référencée par
-- attachments_id partout où des fichiers sont joints.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  last_modified TEXT,
  created TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
