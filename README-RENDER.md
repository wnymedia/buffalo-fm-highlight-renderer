# Buffalo.fm Highlight Renderer — Render.com

Deploy this folder as a Render Web Service.

Recommended Render settings:
- Runtime: Docker
- Root directory: leave blank if this folder is repository root
- Health check path: /health
- Environment variables: none required for basic beta

The app listens on process.env.PORT and binds to 0.0.0.0.
FFmpeg and FFprobe are installed by the Dockerfile.
