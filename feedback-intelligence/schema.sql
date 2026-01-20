-- Feedback Intelligence Platform - D1 Schema
-- This schema stores structured metadata about feedback items
-- Raw feedback content is stored in R2, with references here

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'PROCESSING',

  -- Raw content reference in R2
  r2_key TEXT NOT NULL,

  -- Original feedback text
  original_text TEXT NOT NULL,

  -- AI-generated insights (populated by Workflow)
  sentiment TEXT,
  category TEXT,
  urgency TEXT,
  summary TEXT,

  -- Vector embedding reference (populated by Workflow)
  vector_id TEXT,

  -- Search metadata
  tags TEXT,

  -- Tracking
  updated_at TEXT,
  processing_completed_at TEXT
);

-- Index for efficient searching
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_sentiment ON feedback(sentiment);
CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(category);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);
