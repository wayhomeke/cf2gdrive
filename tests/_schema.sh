#!/usr/bin/env bash
# Shared idempotent DDL guard for the local D1 instance.
#
# .wrangler/state persists between runs, so a suite that reuses it can drift
# behind schema.sql after a version bump. Every suite sources this file right
# after `cd` to the project root:
#
#     . ./tests/_schema.sh
#
# A `wrangler d1 execute --local` costs ~7s in this sandbox (node + miniflare
# boot), so the DDL only runs once per schema version: a stamp file records
# that the local DB was verified. Bump the stamp name when schema.sql changes.
#
# CREATE ... IF NOT EXISTS is applied in one round trip; ALTER TABLE cannot be
# made idempotent in SQLite, so each column is attempted separately and the
# "duplicate column" error is deliberately swallowed.

STAMP=".wrangler/state/schema-stamp-v128"
[ -f "$STAMP" ] && return 0

wrangler d1 execute cf-picbed-db --local --command "
CREATE TABLE IF NOT EXISTS share_links (id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER NOT NULL REFERENCES images (id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, expires_at TEXT, views INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_shares_token ON share_links (token);
CREATE INDEX IF NOT EXISTS idx_shares_image ON share_links (image_id);
CREATE INDEX IF NOT EXISTS idx_shares_creator ON share_links (created_by, revoked);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, actor_email TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);
CREATE TABLE IF NOT EXISTS storage_dirs (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL, bucket INTEGER NOT NULL, root_folder_id TEXT, drive_folder_id TEXT, file_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (owner_key, bucket));
CREATE INDEX IF NOT EXISTS idx_storage_dirs_prefix ON storage_dirs (owner_key, file_count);
CREATE INDEX IF NOT EXISTS idx_images_public ON images (visibility, created_at DESC, id DESC) WHERE deleted = 0;
CREATE TABLE IF NOT EXISTS relay_files (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, drive_file_id TEXT NOT NULL, name TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')), views INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, folder TEXT NOT NULL, storage_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_relay_user ON relay_files (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_relay_live ON relay_files (user_id, deleted);
CREATE INDEX IF NOT EXISTS idx_relay_filter ON relay_files (user_id, deleted, visibility, id DESC);
CREATE INDEX IF NOT EXISTS idx_relay_sweep ON relay_files (deleted, deleted_at);
CREATE TABLE IF NOT EXISTS user_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE, folder TEXT NOT NULL UNIQUE, drive_folder_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS relay_shares (id INTEGER PRIMARY KEY AUTOINCREMENT, relay_file_id INTEGER NOT NULL REFERENCES relay_files (id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE, expires_at TEXT, views INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_relay_shares_token ON relay_shares (token);
CREATE INDEX IF NOT EXISTS idx_relay_shares_file ON relay_shares (relay_file_id);
" > /dev/null 2>&1 || true

for col in "images|exif|TEXT" "images|dir_id|INTEGER" "images|storage_path|TEXT" "images|public_id|TEXT" "api_keys|expires_at|TEXT" "users|relay_quota_bytes|INTEGER DEFAULT 2147483648" "users|relay_used_bytes|INTEGER DEFAULT 0"; do
  tbl=$(echo "$col" | cut -d'|' -f1)
  name=$(echo "$col" | cut -d'|' -f2)
  type=$(echo "$col" | cut -d'|' -f3)
  wrangler d1 execute cf-picbed-db --local --command "ALTER TABLE $tbl ADD COLUMN $name $type;" > /dev/null 2>&1 || true
done

# indexes on columns added above — must run after the ALTERs
wrangler d1 execute cf-picbed-db --local --command "CREATE INDEX IF NOT EXISTS idx_images_dir ON images (dir_id);" > /dev/null 2>&1 || true

# v1.25: backfill the opaque public id for rows created before it existed
wrangler d1 execute cf-picbed-db --local --command "UPDATE images SET public_id = lower(hex(randomblob(6))) WHERE public_id IS NULL;" > /dev/null 2>&1 || true
wrangler d1 execute cf-picbed-db --local --command "CREATE UNIQUE INDEX IF NOT EXISTS idx_images_public_id ON images (public_id);" > /dev/null 2>&1 || true

# stamp only when the schema really is current
# 6 = 3 images columns + storage_dirs + relay_files + user_folders
OK=$(wrangler d1 execute cf-picbed-db --local --json --command "
SELECT (SELECT COUNT(*) FROM pragma_table_info('images') WHERE name IN ('dir_id','storage_path','public_id'))
     + (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('storage_dirs','relay_files','user_folders')) AS ok;" 2>/dev/null \
  | tr -d '\n ' | sed 's/.*"ok":\([0-9]*\).*/\1/')
if [ "$OK" = "6" ]; then
  mkdir -p "$(dirname "$STAMP")" && touch "$STAMP"
fi
