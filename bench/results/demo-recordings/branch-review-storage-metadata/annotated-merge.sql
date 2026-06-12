-- FORGER annotated merge preview
-- Workload: storage-metadata
-- Verdict: PASS
-- actualTimeMs: 96.80 -> 5.40 (-94.4%)
-- cpuTimeMs: 94.20 -> 5.00 (-94.7%)
-- diskBytes: 12.8 MB -> 256.0 KB (-98.0%)
-- memoryBytes: 31.5 MB -> 1.3 MB (-96.0%)
-- seqScans: 1.00 -> 0.00 (-100.0%)

CREATE INDEX idx_forger_storage_bucket_owner_updated ON forger_storage_objects(bucket_id, owner_id, updated_at DESC);
