-- Wrangla database schema (Cloudflare D1 / SQLite).
-- Loaded automatically on every deploy (see the deploy script in package.json), or by hand with:
--   wrangler d1 execute DB --remote --file=./schema.sql
-- It is safe to run more than once: every statement is IF NOT EXISTS, so an existing database keeps all its data.
-- Note that it never alters a table that already exists, so a future change to a table needs its own migration.
--
-- Naming note: the UI says "job sites", but the table and the location_type value keep the
-- older name project_sites / 'project_site'. That is deliberate (wording-only change, no migration).

-- Users: the workers + admin who log in
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'worker',   -- 'admin' | 'worker'
  color TEXT NOT NULL DEFAULT '#3B6E71', -- color-codes their items on the calendar
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Clients
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  nickname TEXT,               -- short name for tight spaces, e.g. "Acme" for "Acme Building"
  address TEXT,               -- head office / billing address
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Project sites: a client can have several (e.g. multiple construction sites)
CREATE TABLE IF NOT EXISTS project_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,         -- e.g. "Harbour Street - Block C"
  address TEXT NOT NULL,
  contact_name TEXT,          -- site supervisor / on-site contact, often different from the client's office contact
  phone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sites_client ON project_sites(client_id);

-- Appointments AND tasks live in one table, distinguished by activity_type
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  site_id INTEGER REFERENCES project_sites(id), -- set when location_type = 'project_site'
  created_by INTEGER NOT NULL REFERENCES users(id),
  activity_type TEXT NOT NULL DEFAULT 'appointment', -- 'appointment' | 'task'
  job_type TEXT,           -- free text, e.g. 'Site Inspection', 'Install' — whatever the admin types; suggested from past entries
  location_type TEXT NOT NULL DEFAULT 'head_office',  -- 'head_office' | 'project_site'
  site_address TEXT,       -- fallback one-off address if no site_id chosen
  scheduled_date TEXT,     -- YYYY-MM-DD, the first day of an appointment (no fixed time)
  due_date TEXT,           -- YYYY-MM-DD, the first day of a task (a task has no scheduled_date)
  status TEXT NOT NULL DEFAULT 'scheduled', -- 'scheduled' | 'completed' | 'cancelled'
  estimate_minutes INTEGER, -- expected total time, spread evenly across the item's days
  days INTEGER NOT NULL DEFAULT 1, -- how many working days the item runs for, starting on its date
  completed_at TEXT,
  notes TEXT,
  series_id TEXT,          -- set when this occurrence was generated from a recurring series
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(scheduled_date);
-- Tasks have a due date instead of a scheduled date. This lets the calendar and the reports find a date range without reading every job.
CREATE INDEX IF NOT EXISTS idx_appt_due ON appointments(due_date);
-- Lets the calendar find the longest job with one row read, so it knows how far back a date range has to look.
CREATE INDEX IF NOT EXISTS idx_appt_days ON appointments(days);
CREATE INDEX IF NOT EXISTS idx_appt_client ON appointments(client_id);
CREATE INDEX IF NOT EXISTS idx_appt_series ON appointments(series_id);

-- Running notes thread per job — everyone can see and add to it
CREATE TABLE IF NOT EXISTS job_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_appt ON job_comments(appointment_id);

-- Files (photos, PDFs, etc.) attached to a job — actual bytes live in R2, this is just the metadata
CREATE TABLE IF NOT EXISTS job_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_appt ON job_attachments(appointment_id);

-- Company details and branding. One row per setting (company_name, company_address,
-- company_phone, company_email, company_reg, logo_key, logo_type, logo_version, setup_complete ...)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Emailed two-factor login codes. Only a keyed hash of the code is stored, never the code itself.
CREATE TABLE IF NOT EXISTS login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,         -- ISO timestamp, about 10 minutes after creation
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_codes_user ON login_codes(user_id);

-- Hours actually worked: one row per person per day, per item. Reports and utilisation read from here.
CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,   -- YYYY-MM-DD
  start_time TEXT,           -- HH:MM
  end_time TEXT,             -- HH:MM
  minutes INTEGER NOT NULL DEFAULT 0,
  UNIQUE (appointment_id, user_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_time_date ON time_entries(work_date);
CREATE INDEX IF NOT EXISTS idx_time_user ON time_entries(user_id);

-- Who is on an item: one row per person. An item with no rows is unassigned and shows in red.
-- The form only picks one person today, but two-person items need no data change.
CREATE TABLE IF NOT EXISTS item_people (
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (appointment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_item_people_user ON item_people(user_id);

-- The types of work used on jobs, and how many jobs use each, so the "type of work" suggestions don't have to count every job.
-- The triggers keep it right whenever a job is created, deleted or has its type changed (renamed, cleared or set), whichever
-- way that happens. The two statements at the end fill it from the jobs; they only ever touch this table, so they are
-- safe to run again and again, and bring an existing install's list up to date.
CREATE TABLE IF NOT EXISTS job_types (
  name TEXT PRIMARY KEY,
  uses INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS job_types_after_insert AFTER INSERT ON appointments
WHEN NEW.job_type IS NOT NULL AND NEW.job_type != ''
BEGIN
  INSERT INTO job_types (name, uses) VALUES (NEW.job_type, 1)
  ON CONFLICT(name) DO UPDATE SET uses = uses + 1;
END;

CREATE TRIGGER IF NOT EXISTS job_types_after_delete AFTER DELETE ON appointments
WHEN OLD.job_type IS NOT NULL AND OLD.job_type != ''
BEGIN
  UPDATE job_types SET uses = uses - 1 WHERE name = OLD.job_type;
  DELETE FROM job_types WHERE uses <= 0;
END;

CREATE TRIGGER IF NOT EXISTS job_types_after_update AFTER UPDATE OF job_type ON appointments
WHEN OLD.job_type IS NOT NEW.job_type
BEGIN
  UPDATE job_types SET uses = uses - 1 WHERE OLD.job_type IS NOT NULL AND OLD.job_type != '' AND name = OLD.job_type;
  DELETE FROM job_types WHERE uses <= 0;
  INSERT INTO job_types (name, uses) SELECT NEW.job_type, 1 WHERE NEW.job_type IS NOT NULL AND NEW.job_type != ''
  ON CONFLICT(name) DO UPDATE SET uses = uses + 1;
END;

INSERT OR REPLACE INTO job_types (name, uses)
  SELECT job_type, COUNT(*) FROM appointments WHERE job_type IS NOT NULL AND job_type != '' GROUP BY job_type;
DELETE FROM job_types WHERE name NOT IN (SELECT job_type FROM appointments WHERE job_type IS NOT NULL AND job_type != '');
