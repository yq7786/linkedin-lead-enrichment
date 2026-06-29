# Portal API

## Submit candidate

Do not test this endpoint unless the user explicitly asks.

```text
POST {PORTAL_QUALIFIED_INGEST_URL}
x-make-callback-secret: {PORTAL_CALLBACK_SECRET}
```

Default endpoint:

```text
https://portal.leapsheep.com/api/webhooks/lead-enrichment/qualified-ingest
```

Payload is derived from the candidate file JSON block:

```json
{
  "source": "linkedin_lead_enrichment",
  "inventoryId": "<uuid from candidate.candidate.inventoryId>",
  "identity": { "firstName", "lastName", "linkedinProfileUrl", "headline", "location" },
  "profile": {},
  "activity": [],
  "company": {},
  "companyWebsite": [],
  "fit": { "founderSignal", "startupSignal", "recentActivitySignal", "fitScore", "fitReasoning" }
}
```

## Portal responsibilities

After accepting a candidate, the portal:

1. Matches or creates `new_individual` and `new_company` records.
2. Updates `linkedin_connection_inventory.individual_id` and `company_id` for the submitted `inventoryId`.
3. Generates outreach drafts and manages the approval queue.

The local workflow does not create portal CRM records or set `individual_id` / `company_id` before submission.

The local workflow writes `audit_events` through `submit-qualified` after success or failure. Do not insert audit rows manually.

## Qualification gate

Submit only when all three fit signals are true:

```text
founderSignal && startupSignal && recentActivitySignal
```
