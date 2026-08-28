<!-- SPDX-License-Identifier: AGPL-3.0-only -->
## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The reasoning, not the restatement. A reviewer can read the diff; they cannot read
     why you chose this over the alternative you rejected. -->

## Spending-path checklist

Tick only what you actually verified. Leave the rest unticked — an unticked box is
information; a wrongly ticked one is a lie that outlives you.

- [ ] No new tool can increase spend without going through `onayAl` with a risk tag
- [ ] Any new trust-chain link is wired to **all** its consumers: `kararGunlugu.ts`
      fields, `config.ts` key slice, `AG_KAPISI_IZLERI` in the brain, `.env.example`,
      both READMEs
- [ ] Any new destructive tool appears in `KAPI_KAPSAMI` (`test/kapiKapsami.test.ts`)
      with a test that proves it refuses on a swapped SIM
- [ ] Failure modes fail **closed**: unknown, unreachable and contradictory all refuse
- [ ] No secret can reach the agent — upstream error text is sanitised, numbers masked
- [ ] Documentation claims match measured reality (no "verified" that was not run)

## Verification

<!-- Paste what you ran, not what you intend to run.

     npm run typecheck && npm test
     npm run smoke                       # live, read-only
     npm run demo -- --musteri <id>      # three acts, dry
     npm run prova -- --musteri <id>     # preflight
-->

## Notes for the reviewer

<!-- Anything you are unsure about, or deliberately left out of scope. Saying so here is
     cheaper than having it found later. -->
