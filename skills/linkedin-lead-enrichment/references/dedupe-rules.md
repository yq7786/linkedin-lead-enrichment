# Dedupe Rules

## Inventory sync

Upsert into `linkedin_connection_inventory` by normalized `linkedin_profile_url`. One row per profile URL.

## Inventory to portal CRM

Run `dedupe-inventory` **after** `process-queue` and `sync-company-profiles` so `current_company_name` is populated before matching.

`dedupe-inventory` checks whether a connection already exists in the portal before continuing enrichment.

Match rule (all three required):

```text
first_name + last_name + company_name
```

Implementation details:

- Split inventory `full_name` into first name and last name (first token vs remainder).
- Compare case-insensitively against `new_individual.first_name`, `new_individual.last_name`, and `new_company.name`. See [portal-crm-tables.md](portal-crm-tables.md).
- Require inventory `current_company_name` to be present; otherwise queue for enrichment without CRM lookup.

Outcomes:

| Match result | Inventory update |
| --- | --- |
| Exactly one CRM match | Set `individual_id`, `company_id`; `workflow_status = deduped_existing` |
| Multiple CRM matches | `workflow_status = failed_needs_review` |
| No match | `dedupe_status = not_found`; continue with `sync-activities` |

Portal submission can still create or link CRM records for queued connections. If a row was already linked here, skip re-enrichment unless the operator resets it.

## Qualification gate

Only submit candidates when all three booleans are true:

```text
founderSignal && startupSignal && recentActivitySignal
```

`recentActivitySignal` means at least one visible LinkedIn post or comment in the last 6 months.
