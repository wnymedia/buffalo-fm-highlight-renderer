# Buffalo.fm Highlight Renderer 0.1.2

This build adds retryable chunked uploads for real iPhone concert media.

## Render deployment
Upload the CONTENTS of this folder to the existing `buffalo-fm-highlight-renderer` GitHub repo. Render should auto-deploy the commit.

Health check: `/health`

A successful health response includes `"uploadMode":"chunked-v1"`.

New flow:
- POST `/api/uploads/start`
- PUT `/api/uploads/:id/chunk?offset=...` in ~5 MB chunks
- POST `/api/uploads/:id/complete`
- POST `/api/generate-job` with upload IDs

The old giant multipart `/api/generate` route is kept temporarily for compatibility, but the WordPress beta 0.1.5 no longer uses it.
