# Contributing

## Development setup

1. Install Node.js 20.17 or newer.
2. Install Git.
3. Install dependencies with `npm install`.
4. Start the application with `npm run dev`.

Run the backend integration test with:

```bash
npm test
```

## Repository conventions

- Keep Electron bootstrap code in `main/`.
- Put domain operations in `main/services/`.
- Put renderer modules in `renderer/js/core/` or `renderer/js/apps/`.
- Keep each app module focused on one tool.
- Prefer existing UI helpers and window-manager APIs over duplicated implementation.
- Preserve the renderer sandbox and add no unnecessary privileged access.
- Validate backend input at the IPC and service boundaries.

## Pull requests

- Describe the problem and the implemented behavior.
- Include reproduction steps or test evidence.
- Keep unrelated formatting and refactoring out of the change.
- Run `npm test` before submitting.
