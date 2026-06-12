-- FORGER annotated merge preview
-- Workload: slow-query-index
-- Verdict: PASS
-- actualTimeMs: 132.40 -> 8.90 (-93.3%)
-- cpuTimeMs: 129.60 -> 8.10 (-93.8%)
-- diskBytes: 18.0 MB -> 512.0 KB (-97.2%)
-- memoryBytes: 40.2 MB -> 3.0 MB (-92.5%)
-- seqScans: 1.00 -> 0.00 (-100.0%)

CREATE INDEX idx_forger_orders_customer_id ON forger_orders(customer_id);
