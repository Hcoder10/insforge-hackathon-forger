-- FORGER annotated merge preview
-- Workload: pagination-scale
-- Verdict: PASS
-- actualTimeMs: 247.20 -> 12.60 (-94.9%)
-- cpuTimeMs: 240.80 -> 11.90 (-95.1%)
-- diskBytes: 29.5 MB -> 768.0 KB (-97.5%)
-- memoryBytes: 64.3 MB -> 4.0 MB (-93.8%)
-- seqScans: 1.00 -> 0.00 (-100.0%)

CREATE INDEX idx_forger_events_tenant_created ON forger_events(tenant_id, created_at DESC);
