# Where is the VARUNA code?

The VARUNA repository lives at **C:\dev\varuna** (outside OneDrive, no spaces in the path).

Why: OneDrive sync and Windows file locks break `pnpm install`, Next.js builds and `uv sync`
(we hit "Access is denied" inside `.venv` on the first install), and GNU make cannot handle
the space in "for sih". The repo is a normal git repository, so it can be moved or pushed anywhere.

This folder keeps the spec (`CLAUDE.md`) and the blueprint PDF for reference; the copies inside
`C:\dev\varuna` are the ones the build uses.
