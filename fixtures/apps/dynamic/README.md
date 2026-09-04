# Dynamic fixture (App B)

This local fixture models an authenticated SaaS flow. The approved flow signs in through the visible form, selects a plan (dropdown), opens a details modal, waits for delayed async data, and shows a save toast. `POST /__reset` restores the baseline count, `POST /__change` changes it for selective recapture, and `POST /__failure?action=dynamic-load-async` holds the async checkpoint in a named error state.
