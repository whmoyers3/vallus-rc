# VRC Authentication

## Current Auth Mode

The deployed app should use Supabase Auth for staff login.

Set these Vercel environment variables:

```env
VRC_AUTH_MODE=supabase
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_ANON_KEY=your-anon-public-key
```

`APP_PASSWORD` is now legacy. It is only used when `VRC_AUTH_MODE=basic`, or when no Supabase anon key is configured and the app falls back to Basic Auth.

## Supabase Setup

1. Open the Supabase project.
2. Go to Authentication.
3. Enable email/password sign-in.
4. Create staff users manually or invite them.
5. Confirm users are active before giving them the VRC URL.

## User Experience

Users see an in-app VRC sign-in screen instead of the browser Basic Auth popup.

The frontend stores the Supabase access token in local storage and a same-site cookie:

- local storage supports normal API calls through `fetch`
- cookie supports direct download links such as PDF reports and airflow workbooks

The API verifies each request against Supabase using the server-side service-role client.

## Protected Routes

The React frontend is served publicly so the login page can load.

API routes under `/api/*` require a valid Supabase access token, except:

- `/api/health`
- `/health`
- `/api/auth/config`

## Local Development

For local development without auth, set:

```env
VRC_AUTH_MODE=none
```

For legacy Basic Auth testing:

```env
VRC_AUTH_MODE=basic
APP_PASSWORD=your-test-password
```

