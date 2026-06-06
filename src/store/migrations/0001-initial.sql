-- Migration 0001 — initial schema (SPEC §6.4).
-- The central SQLite history: one `runs` row per audit, exploded into
-- `criterion_results` for cheap drift/trend queries, plus a content-keyed
-- `investigation_cache` so agent re-runs are deterministic at a fixed commit.
-- Applied exactly once; the runner gates on PRAGMA user_version.

-- one row per audit run
CREATE TABLE runs (
  id             INTEGER PRIMARY KEY,
  repo           TEXT NOT NULL,          -- matches targets.yaml id
  commit_sha     TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  level          INTEGER NOT NULL,
  pass_rate      REAL NOT NULL,
  coverage       REAL NOT NULL,
  report_json    TEXT NOT NULL,          -- full §6.3 report
  scored_at      TEXT NOT NULL
);
CREATE INDEX runs_repo_time ON runs (repo, scored_at);

-- per-criterion rows for cheap drift/trend queries
CREATE TABLE criterion_results (
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  criterion   TEXT NOT NULL,
  numerator   INTEGER,                   -- nullable (N/A)
  denominator INTEGER NOT NULL,
  na_kind     TEXT,                      -- not-applicable | no-detector | NULL
  rationale   TEXT NOT NULL
);
CREATE INDEX cr_run ON criterion_results (run_id);

-- cached agent-investigation findings, keyed by content so re-runs are
-- deterministic unless code changed (see §7.3)
CREATE TABLE investigation_cache (
  repo          TEXT NOT NULL,
  commit_sha    TEXT NOT NULL,
  area          TEXT NOT NULL,           -- one of the 4 investigation areas
  findings_json TEXT NOT NULL,           -- zod-validated facts (§7.2)
  created_at    TEXT NOT NULL,
  PRIMARY KEY (repo, commit_sha, area)
);
