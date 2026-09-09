<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Privacy Policy

*Last updated: 7 September 2026*

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
| Decision log — one JSONL line per risk-tagged network decision | A file on the operator's disk, at the path in `AEGIS_DECISION_LOG`. **Unset = no file is created and nothing is written** | Plain text, size-capped and rolled over. A line holds: timestamp, a shortened action summary, the ad account ID, risk tier, verdict, which network links ran and over which channel, the look-back windows, the daily amount at stake, the refusal codes, and the approver's number **masked** (for example `+905*******33`). Never a full phone number, never a token, never raw text from an upstream provider | Letting the account owner answer afterwards: how often was I refused, over which channel, for what amount |

In local (stdio) mode there is no database at all: credentials live in the user's own
`.env` file on their own machine.

## Where data goes

Nothing is sold, and nothing is sent anywhere for our own benefit. But Aegis is **not a
Google-only client**: optional features that the operator switches on with an environment
variable reach other providers, and one of them carries a phone number. Every destination
the software can talk to is listed here.

| Destination | What is sent | When |
|---|---|---|
| Google Ads API (`googleapis.com`) | The user's own requests — reports read, campaigns, budgets and ads written — with the user's OAuth token | Always; this is the core function |
| Nokia Network-as-Code (GSMA Open Gateway / CAMARA), reached through the RapidAPI gateway `network-as-code.nokia.rapidapi.com` | **The approver's full phone number in E.164 form** (`AEGIS_APPROVER_PHONE`), plus a look-back window in hours, on every risk-tagged spending action. Every link in the network gate that reaches the provider queries that number, so that money never moves on a hijacked line — today the SIM-swap, device-reachability, location/roaming, device-swap and call-forwarding checks, and any link added to the gate later goes to the same place with the same number. (The number-verification link is simulated in-process and reaches no one.) Both Nokia and the RapidAPI gateway operator see that number | Only when `AEGIS_NAC_TOKEN` and `AEGIS_APPROVER_PHONE` are both set. **Off by default** |
| Meta Marketing API (`graph.facebook.com`) | Campaign, ad set and creative data for the campaign being read or created, together with the Meta access token | Only when `AEGIS_META_TOKEN` and `AEGIS_META_AD_ACCOUNT_ID` are set. **Off by default** |
| The website the user asks about | An ordinary HTTP GET to the URL passed to `analyze_site`; that site's operator sees the request as they would any other visit | Only when `analyze_site` is called |
| Google AI Studio / Gemini (`generativelanguage.googleapis.com`), or Anthropic (`api.anthropic.com`) with `AEGIS_BRAIN_PROVIDER=anthropic` | The campaign planner (`npm run brain`) sends the goal the user typed and the facts extracted from the analysed page to the model provider | Only when the planner is run, with `AEGIS_GEMINI_API_KEY` / `ANTHROPIC_API_KEY` configured. **Off by default** |
| Anthropic (`api.anthropic.com`), through the bundled agent demo | The task sentence the operator types, **plus every Aegis tool result the model asks for** — Google Ads report rows, campaign and account identifiers, and the network gate's refusal text, in which the approver's number appears only masked | Only when the agent demo (`npm run agent`, `scripts/demo-agent.mjs`) is run, with `ANTHROPIC_API_KEY` or a local `ant` profile configured. **Off by default**; it is a demonstration script driving the server from a terminal, not part of the server itself |

An operator who cannot make one of these disclosures to their own users should leave the
matching feature switched off: with its environment variable unset the software makes no
request to that destination at all.

## What the software does not do

- **No advertising data is stored.** Campaign statistics, keywords and search terms are
  fetched from the Google Ads API on request, returned to the user's MCP client, and not
  retained. Not retained is not the same as not transmitted: those rows go to whichever
  MCP client asked for them, and if that client is a model-backed assistant — including
  the agent demo shipped in this repository — they travel on to that model's provider,
  as the table above states.
- **No data is sold.** Nothing is transmitted for our benefit, and nothing goes to any
  destination beyond the ones listed under "Where data goes" above.
- **The approver's number is checked, not kept.** It is sent to the CAMARA provider to be
  verified and is stored nowhere; in the decision log it appears only masked.
- **No analytics, no tracking.** The software embeds no telemetry, no third-party
  scripts and no advertising identifiers.
- **No training.** Nothing the software handles is used to train AI models by us. Where the
  planner or the agent demo is switched on, what the model provider does with what it
  receives is governed by that provider's own terms — read them before enabling it.

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

On a hosted instance, disconnecting your account deletes the stored refresh token. The
decision log, when the operator has switched it on, is a file on that operator's own disk
and is removed by deleting or rotating that file.
Because the software is AGPL-licensed, every hosted instance must offer its users the
Corresponding Source, so what an instance does with data is always inspectable.

## Contact

Questions about this policy or the software: open an issue at
[github.com/Xaena53/aegis](https://github.com/Xaena53/aegis/issues)
or write to bedometom@gmail.com.
