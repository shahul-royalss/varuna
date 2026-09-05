# Changelog

All notable changes to the VARUNA prototype. Task IDs refer to CLAUDE.md section 13.

## Unreleased

### Phase 0
- Repository initialised at `C:\dev\varuna` (ADR-0001); Python uv workspace with 12 members; pnpm workspace with the Next.js 16 command app; design tokens JSON.
- [P0.6/P0.10/P0.11] Offline network guard in `tests/conftest.py` (`VARUNA_OFFLINE=1`), repository layout test, Playwright config with both web servers and a Phase 0 smoke spec, GitHub Actions CI (web, python, e2e, Lighthouse), `lighthouserc.json`, `docker-compose.yml` (P1 profile), `.pre-commit-config.yaml`, README with make targets and the cycle diagram, `docs/API.md`.
