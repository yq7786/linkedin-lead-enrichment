# Portal CRM tables (read only)

Existing portal contacts and companies live in Neon tables owned by the portal. The local workflow **reads** these during `dedupe-inventory` only. Do not insert or update CRM rows locally.

## Agent access

| Table | Access | Used by |
| --- | --- | --- |
| `new_individual` | Read only | `dedupe-inventory` name match |
| `new_company` | Read only | `dedupe-inventory` company name match |

CRM creation and updates for new leads happen in the portal after `submit-qualified`.

## Columns used by dedupe-inventory

### new_individual

| Column | Role in dedupe |
| --- | --- |
| `id` | Written to `linkedin_connection_inventory.individual_id` on match |
| `first_name` | Compared to first token of inventory `full_name` |
| `last_name` | Compared to remainder of inventory `full_name` |
| `new_company_id` | Join key to `new_company` |

Other columns (`email`, `linkedin_link`, `mobile`, etc.) exist in the portal but are **not** used by this workflow.

### new_company

| Column | Role in dedupe |
| --- | --- |
| `id` | Written to `linkedin_connection_inventory.company_id` on match |
| `name` | Compared to inventory `current_company_name` |

Other columns (`website`, `linkedin`, `linkedin_company_id`, etc.) are not used by dedupe.

## Join used at dedupe time

```sql
select i.id, i.new_company_id, c.name
from new_individual i
left join new_company c on c.id = i.new_company_id
where lower(trim(i.first_name)) = lower(trim($firstName))
  and lower(trim(coalesce(i.last_name, ''))) = lower(trim($lastName))
  and lower(trim(coalesce(c.name, ''))) = lower(trim($companyName))
```

See [dedupe-rules.md](dedupe-rules.md) for match outcomes.
