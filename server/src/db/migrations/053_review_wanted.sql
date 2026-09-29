-- A review asked for (scheduleReview) but not yet written: kept on the
-- complaint so a restart within the two-minute wait doesn't lose it
-- (complaintReview.js#resumeWantedReviews at start-up).
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS review_wanted_at TIMESTAMPTZ;
