<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Privacy Policy

*Last updated: 13 August 2026*

This policy covers **Aegis**, an open-source MCP server that connects an AI assistant
to a Google Ads account. It applies to the software as published in this repository and
to any hosted instance run from unmodified source.

Aegis is self-hosted software. Whoever operates an instance is the data controller
for that instance; this document describes what the software itself collects, stores and
transmits, so both operators and their users know exactly what is at stake.

## What the software stores

| Data | Where | Protection | Why |
|---|---|---|---|
| Google OAuth refresh token | Operator's SQLite database | Encrypted at rest (AES-256-GCM, key derived via scrypt from the operator's master key) | Calling the Google Ads API on the user's behalf |
| Google account subject ID and email | Operator's SQLite database | Plaintext row data | Binding each session and API key to exactly one user |
| API key | Operator's SQLite database | Stored only as a SHA-256 hash | Authenticating the user's MCP client |
| Per-user settings (budget ceiling, write permission) | Operator's SQLite database | Plaintext row data | Enforcing the user's own guardrails |

In local (stdio) mode there is no database at all: credentials live in the user's own
`.env` file on their own machine.

## What the software does not do

- **No advertising data is stored.** Campaign statistics, keywords and search terms are
  fetched from the Google Ads API on request, returned to the user's MCP client, and not
  retained.
- **No data is sold or shared.** Nothing is transmitted to any party other than Google
  (to serve the user's own requests) and the user's own MCP client.
- **No analytics, no tracking.** The software embeds no telemetry, no third-party
  scripts and no advertising identifiers.
- **No training.** Nothing the software handles is used to train AI models.

## Google user data

Aegis accesses Google user data (the `adwords` OAuth scope) strictly to execute the
requests the authenticated user makes through their own MCP client — reading reports and
managing campaigns in accounts that user already controls. Use of data received from
Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including its Limited Use requirements.

Users can revoke Aegis's access at any time at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions); revocation
immediately invalidates the stored refresh token.

## Data removal

On a hosted instance, disconnecting your account deletes the stored refresh token.
Because the software is AGPL-licensed, every hosted instance must offer its users the
Corresponding Source, so what an instance does with data is always inspectable.

## Contact

Questions about this policy or the software: open an issue at
[github.com/Xaena53/google-ads-mcp](https://github.com/Xaena53/google-ads-mcp/issues)
or write to bedometom@gmail.com.
