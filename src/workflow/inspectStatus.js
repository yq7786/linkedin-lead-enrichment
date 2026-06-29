export async function inspectWorkflowStatus(client) {
  const workflowRuns = await countByStatus(client, "workflow_runs", "status");
  const inventoryStatuses = await countByStatus(client, "linkedin_connection_inventory", "workflow_status");
  const pendingProfileCapture = await countRows(
    client,
    `select count(*) as count
     from linkedin_connection_inventory
     where workflow_status = 'discovered'
       and dedupe_status = 'dedupe_pending'`
  );
  const retryableDue = await countRows(
    client,
    `select count(*) as count
     from linkedin_connection_inventory
     where workflow_status = 'failed_retryable'
       and (next_retry_at is null or next_retry_at <= now())`
  );

  return {
    workflowRuns,
    inventoryStatuses,
    pendingProfileCapture,
    retryableDue
  };
}

async function countByStatus(client, tableName, columnName) {
  const result = await client.query(
    `select ${columnName} as status, count(*) as count
     from ${tableName}
     group by ${columnName}
     order by ${columnName}`
  );

  return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]));
}

async function countRows(client, query) {
  const result = await client.query(query);
  return Number(result.rows[0]?.count ?? 0);
}
