-- Legacy in-flight sends did not persist a send boundary. Conservatively hold
-- them as ambiguous on the first rollout; never infer that they were unsent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'publications' AND column_name = 'send_started_at') THEN
    ALTER TABLE publications ADD COLUMN send_started_at timestamptz;
    UPDATE publications SET send_started_at = updated_at WHERE status = 'publishing';
  END IF;
END $$;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS dispatch_version integer NOT NULL DEFAULT 0;
