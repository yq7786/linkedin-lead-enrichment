export async function createDbClient(connectionString) {
  let pg;
  try {
    pg = await import("pg");
  } catch {
    throw new Error("The pg package is required for database access. Install dependencies before live DB runs.");
  }
  return new pg.Client({ connectionString });
}
