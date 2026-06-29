export const schemaMapping = {
  inventory: {
    requiredReference: "skills/linkedin-lead-enrichment/references/inventory-table.md",
    table: "linkedin_connection_inventory",
    id: "id",
    linkedinProfileUrl: "linkedin_profile_url",
    individualId: "individual_id",
    companyId: "company_id",
    workflowStatus: "workflow_status"
  },
  portalCrm: {
    requiredReference: "skills/linkedin-lead-enrichment/references/portal-crm-tables.md",
    tables: ["new_individual", "new_company"],
    readOnly: true
  },
  audit: {
    requiredReference: "skills/linkedin-lead-enrichment/references/inventory-table.md",
    table: "audit_events",
    readOnly: true
  },
  portal: {
    requiredReference: "skills/linkedin-lead-enrichment/references/portal-api.md"
  }
};
