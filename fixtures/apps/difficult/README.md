# Difficult fixture (App C)

This local fixture exercises a multi-step wizard with a file upload and deliberately slow validation. `POST /__reset` restores the baseline validation state, `POST /__change` changes the review state for selective recapture, and `POST /__failure?action=difficult-run-validation` produces a named slow-validation failure.
