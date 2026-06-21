# Takeoff Tool Deployment And Verification

## Preferred Workflow

The preferred development workflow is:

```text
branch locally
  -> implement change
  -> run local build/tests when practical
  -> push to GitHub
  -> Vercel creates preview deployment
  -> verify in the hosted preview URL
  -> merge/promote after validation
```

Localhost is allowed for quick engineering checks, but it is not the primary user validation path for this tool.

## Why

The user prefers the extra time of pushing to GitHub and waiting for a Vercel build over dealing with local server startup, shutdown, proxy, and environment issues. Future sessions should respect that tradeoff.

## Product Placement

Build the takeoff tool inside the existing VRC web app first:

- as a route, tab, or module
- sharing the existing Supabase connection and calculation APIs
- feature-gated or isolated while incomplete

Do not create a separate deployed app unless the user explicitly asks for that later.

## Vercel Notes

The current root `vercel.json` uses:

```json
{
  "buildCommand": "cd frontend && npm install && npm run build",
  "rewrites": [
    { "source": "/:path*", "destination": "/api/index" }
  ]
}
```

This means frontend changes should be validated by the same Vercel build command used for the live app.

## Phase Exit Criteria

Each implementation phase should end with:

- the code committed on a branch
- a successful Vercel preview build
- a hosted preview URL checked for the specific workflow built in that phase
- notes added to `takeoff-tool/CHANGELOG.md`

## Local Checks

When practical, run these before pushing:

```bash
npm run build
```

or from the frontend folder:

```bash
npm run build
```

If local checks are blocked by environment issues, note the reason and rely on the Vercel preview build for validation.
