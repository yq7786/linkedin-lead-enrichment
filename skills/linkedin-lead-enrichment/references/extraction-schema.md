# Extraction Schema

Pre-fit evidence lives in `.lead-enrichment-candidates/*.md` as a fenced JSON block. The portal submission payload is derived from that block.

## Candidate JSON sections

| Section | Contents |
| --- | --- |
| `identity` | `firstName`, `lastName`, `linkedinProfileUrl`, `headline`, `location` |
| `profileCapture.facts` | About, role, job history, contact — no raw HTML or screenshots |
| `activityCapture.items[]` | Post/comment `content`, URL, date, 6-month visibility flag |
| `companyCapture.facts` | Overview, website, phone, industry, size, HQ, founded, specialties |
| `companyWebsite.pages[]` | `pageName`, `pageURL`, `contentMarkdown` |
| `fit` | `founderSignal`, `startupSignal`, `recentActivitySignal`, `fitScore`, `fitReasoning` |
| `candidate` | `inventoryId`, `fileId`, `status`, timestamps |

Do not include `linkedinMemberId` in candidate JSON.
