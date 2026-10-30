-- cf2gdrive schema (D1 / SQLite)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  quota_bytes INTEGER NOT NULL DEFAULT 1073741824,   -- 1 GiB default per user
  used_bytes INTEGER NOT NULL DEFAULT 0,
  relay_quota_bytes INTEGER NOT NULL DEFAULT 2147483648, -- 2 GiB default for relay
  relay_used_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Opaque session tokens; only the SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

-- API keys; only hash + display prefix are stored.
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT,                       -- v1.21: NULL = never expires (SQLite datetime shape)
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);

-- v1.24: sharded Drive storage directories.
-- One row per (md5(email)[0..4] prefix, numeric shard 1..255). The counter is
-- kept here, not derived from Drive listings: choosing a shard must not cost a
-- Drive round trip, and the 255-files-per-directory cap has to be reserved
-- atomically (UPDATE ... WHERE file_count < 255 RETURNING file_count).
CREATE TABLE IF NOT EXISTS storage_dirs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL,            -- level-1 folder name = md5(email)[0..4]
  bucket INTEGER NOT NULL,            -- level-2 folder name = 1..255
  root_folder_id TEXT,                -- cached Drive id of the level-1 folder
  drive_folder_id TEXT,               -- cached Drive id of the level-2 folder
  file_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_key, bucket)
);
CREATE INDEX IF NOT EXISTS idx_storage_dirs_prefix ON storage_dirs (owner_key, file_count);

-- Image metadata; bytes live in Google Drive (drive_file_id).
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- internal only; never appears in a URL
  public_id TEXT,                        -- v1.25: 12 hex chars, the ONLY id in URLs/API
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  drive_file_id TEXT NOT NULL,
  name TEXT NOT NULL,                -- storage-safe name inside Drive
  original_name TEXT NOT NULL,       -- user-visible original filename
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  views INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0, -- soft delete (trash)
  deleted_at TEXT,
  exif TEXT,                             -- v1.12: JSON metadata (camera/settings/dimensions), nullable
  dir_id INTEGER REFERENCES storage_dirs (id),  -- v1.24: shard holding the bytes (NULL = legacy flat files)
  storage_path TEXT,                     -- v1.24: "<prefix>/<bucket>/<name>" for diagnostics
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_images_user_created ON images (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_drive ON images (drive_file_id);
-- v1.20: covering indexes for the hot list/sweep queries (measured via EXPLAIN QUERY PLAN).
CREATE INDEX IF NOT EXISTS idx_images_user_created_id ON images (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_images_user_vis ON images (user_id, visibility, created_at DESC, id DESC) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_images_trash ON images (user_id, deleted, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_sweep ON images (deleted, deleted_at);
-- v1.23: anonymous /explore lists public images across all users, newest first.
CREATE INDEX IF NOT EXISTS idx_images_public ON images (visibility, created_at DESC, id DESC) WHERE deleted = 0;
-- v1.24: the "recount from truth" repair statement counts images per shard.
CREATE INDEX IF NOT EXISTS idx_images_dir ON images (dir_id);
-- v1.25: every external lookup goes through public_id (unique; SQLite allows
-- several NULLs, but every row is backfilled and every insert sets it).
CREATE UNIQUE INDEX IF NOT EXISTS idx_images_public_id ON images (public_id);

-- Fixed-window rate-limit counters.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,     -- unix seconds
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- Invite codes; registration is invite-only (v1.2). Admins create and
-- distribute codes; each redemption atomically increments used_count.
CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,          -- canonical form: XXXX-XXXX-XXXX-XXXX
  created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  used_by INTEGER REFERENCES users (id) ON DELETE SET NULL,  -- last redeemer
  used_at TEXT,
  expires_at TEXT,                    -- NULL = never expires
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invites_created_by ON invite_codes (created_by);

-- Global key/value settings (v1.4). Admins tune these from /admin.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Time-limited share links (v1.13): token grants read access to one image
-- without making it public. Served by GET /s/<token>.
CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id INTEGER NOT NULL REFERENCES images (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT,                    -- NULL = never expires
  views INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shares_token ON share_links (token);
CREATE INDEX IF NOT EXISTS idx_shares_image ON share_links (image_id);
-- v1.20: /api/stats counts active shares per user on every call.
CREATE INDEX IF NOT EXISTS idx_shares_creator ON share_links (created_by, revoked);

-- v1.18: audit log (append-only). Written via ctx.waitUntil, never blocks a response.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,                    -- actor (NULL when unknown, e.g. failed login)
  actor_email TEXT,                   -- snapshot, survives user deletion
  action TEXT NOT NULL,               -- login / login_failed / upload / delete / admin.* ...
  target TEXT,                        -- image id, user id, invite code ...
  detail TEXT,                        -- short human context
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);

-- v1.26: 文件中转 (file relay) — a feature deliberately unrelated to the gallery.
-- Its own table, page and /f/<id> prefix; nothing here touches `images`.
CREATE TABLE IF NOT EXISTS relay_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  drive_file_id TEXT NOT NULL,
  name TEXT NOT NULL,               -- storage name inside the user folder
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  views INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  folder TEXT NOT NULL,             -- per-user folder name (sanitised email)
  storage_path TEXT NOT NULL,       -- "<folder>/<name>" for diagnostics
  content_sha256 TEXT,              -- v2.13.0: hex SHA-256 of the stored bytes
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- v2.19.0: chunked/resumable upload sessions for large relay files.
-- The Drive resumable session URI is the piece of state we must persist, since
-- Workers have no durable filesystem of their own.
CREATE TABLE IF NOT EXISTS relay_upload_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  upload_uri TEXT NOT NULL,
  received_bytes INTEGER NOT NULL DEFAULT 0,
  client_sha256 TEXT,
  storage_name TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_relay_sessions_user ON relay_upload_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_relay_sessions_sweep ON relay_upload_sessions (status, updated_at);

-- v2.13.0 migration for databases created before content_sha256 existed:
-- ALTER TABLE relay_files ADD COLUMN content_sha256 TEXT;
CREATE INDEX IF NOT EXISTS idx_relay_user ON relay_files (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_relay_live ON relay_files (user_id, deleted);
CREATE INDEX IF NOT EXISTS idx_relay_filter ON relay_files (user_id, deleted, visibility, id DESC);
CREATE INDEX IF NOT EXISTS idx_relay_sweep ON relay_files (deleted, deleted_at);

-- v1.27: one Drive folder per user, named after the account email.
-- The folder id is cached here so picking a directory costs zero Drive trips.
CREATE TABLE IF NOT EXISTS user_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  folder TEXT NOT NULL UNIQUE,
  drive_folder_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- v1.31: 文件中转独立临时分享链接 (relay shares)
-- Independent from the gallery's share_links table.
CREATE TABLE IF NOT EXISTS relay_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  relay_file_id INTEGER NOT NULL REFERENCES relay_files (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_relay_shares_token ON relay_shares (token);
CREATE INDEX IF NOT EXISTS idx_relay_shares_file ON relay_shares (relay_file_id);
