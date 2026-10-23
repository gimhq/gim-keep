# gim Module

The app-server side of gim: encrypted per-user storage slots and abuse
reports for gim clients, and the moderators' report inbox. gim hubs stay
stateless about users' preferences; what must outlive a user's devices
(block list, chat settings, privacy switches) lives here as ciphertext the
server cannot read.

## File layout

```text
apps/api/src/modules/gim/
  schema.ts                # `gim_slots`, `gim_reports`
  gim.auth.ts              # root-signed request verification
  gim.service.ts
  gim.raw.routes.ts        # client routes on the raw API
  gim.routes.ts            # moderator routes (admin session)
  gim.backup.ts            # backup contribution
  fixtures/request.json    # gim-core signing vectors
  index.ts                 # registers backup contribution
```

## Authentication

gim users have no account here. Every client request is signed with the
user's Ed25519 root key (gim-core `docs/identity.md`, "Root-signed
requests"):

```
Gim-Key:       base64url(root public key)
Gim-Timestamp: Unix milliseconds
Gim-Signature: base64url(Ed25519(root key, "gim/root-request/v1" || 0x00 ||
               method "\n" path "\n" timestamp "\n" hex(SHA-256(body))))
```

The user id is derived from the key (`"u" + base32(0x12 0x20 ||
SHA-256(key))`), so a request can only act on its signer's data. Requests
more than 5 minutes off the server clock are refused. `fixtures/request.json`
is copied from gim-core `crates/gim-identity/tests/vectors/request.json`;
refresh it when the format changes.

## Database

| Table | Purpose |
|---|---|
| `gim_slots` | One row per (user, slot name): `version` (starts at 1) and `data`, the sealed slot in base64 (sealed by the client with a key derived from the root key). At most 16 slots of 256 KiB per user. |
| `gim_reports` | Abuse reports: reporter and reported user ids, `reason`, `note`, the reported messages in plaintext (JSON), `status` (`open`, `resolved`, `dismissed`), `request_digest` (SHA-256 of the request signature, unique: a replay adds nothing), resolution time and moderator. |

## Routes

Client routes are on the raw API (no session, CSRF or CORS; per-IP rate
limit) and require a root-signed request:

| Method | Path | Description |
|---|---|---|
| GET | `/api/raw/gim/v1/storage/:name` | Reads a slot: `{ version, data }`; 404 if absent. |
| PUT | `/api/raw/gim/v1/storage/:name` | `{ version, data }`: writes `version + 1` if the slot is at `version` (0 creates it), else 409 `VERSION_CONFLICT` with `details.version`. |
| POST | `/api/raw/gim/v1/reports` | `{ reportedUserId, reason, note?, messages: [{ messageId, senderUserId, sentAtMs, text }] }` (at most 50 messages); 201 `{ id }`. 50 reports per reporter per day. |
| DELETE | `/api/raw/gim/v1/me` | Account deletion: removes the signer's slots. Reports stay. |

Moderator routes are mounted under `protectedRoutes`, admin only:

| Method | Path | Description |
|---|---|---|
| GET | `/api/gim/reports?status=&limit=` | Reports with that status (default `open`), newest first. |
| PATCH | `/api/gim/reports/:id` | `{ status }`: resolve, dismiss or reopen. |

## Audit

`gim.report.resolved`, `gim.report.dismissed`, `gim.report.open`.

## Out of scope

- A moderation web page: the inbox is API-only for now.
- Acting on a report (suspending a user is done on the user's hub).
