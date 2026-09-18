import pg from "pg";

const url =
  process.env.DATABASE_URL ??
  "postgres://keystone:keystone@localhost:5439/keystone";

const deadline = Date.now() + 60_000;

async function tryOnce() {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return true;
  } catch {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    return false;
  }
}

while (Date.now() < deadline) {
  if (await tryOnce()) {
    console.log("Postgres is ready.");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.error("Timed out waiting for Postgres.");
process.exit(1);
