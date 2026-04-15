# VIBE.md — Project Testing Guidance

Place this file as `VIBE.md` in your project root. Vibe Test reads it automatically to understand your project's testing needs.

## Test URL
- Production: https://myapp.com
- Staging: https://staging.myapp.com
- Local: http://localhost:3000

## Login URL
/login

## Test Credentials
- Email: test@example.com
- Password: TestPass123!

## Authentication
- Strategy: credentials
- Token storage: localStorage
- Post-login redirect: /dashboard

## Never Automate
- delete account
- cancel subscription
- billing
- [data-testid="danger-zone"]
- .destructive-action

## Known Flaky
- /notifications (WebSocket dependent)
- /reports/export (long-running job)

## Environment
- Requires running backend at localhost:8080
- Needs NEXT_PUBLIC_API_URL set

## Notes
- Profile page requires clicking "Edit Profile" before fields are visible
- Dashboard data loads via WebSocket — wait for [data-loaded="true"]
- File uploads only accept PNG/JPG under 5MB
