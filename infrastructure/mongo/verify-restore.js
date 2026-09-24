// Verifies a restored database (run by infrastructure/scripts/restore.sh with mongosh).
// Inputs (environment):
//   CBI_DB                 database name (cbi_interview)
//   CBI_MANIFEST           JSON manifest written by backup.sh (may be empty: no comparison)
//   CBI_TOLERANCE_PCT      allowed document-count difference vs the manifest, percent (default 1)
//   CBI_TOLERANCE_MIN      ...but never less than this many documents (default 10)
//   CBI_REQUIRE_NONEMPTY   space-separated collections that must have documents
//   CBI_REQUIRE_SUPER_ADMIN  "1" = at least one user with adminRoles SUPER_ADMIN
// Prints one line per check and a final "VERIFY OK" / "VERIFY FAILED"; exits 1 on failure.

const dbName = process.env.CBI_DB || 'cbi_interview';
const d = db.getSiblingDB(dbName);
const tolPct = Number(process.env.CBI_TOLERANCE_PCT ?? '1');
const tolMin = Number(process.env.CBI_TOLERANCE_MIN ?? '10');
const requireNonEmpty = (process.env.CBI_REQUIRE_NONEMPTY || 'users auditLogs interviewSessions')
  .split(/\s+/)
  .filter(Boolean);
const manifest = process.env.CBI_MANIFEST ? JSON.parse(process.env.CBI_MANIFEST) : null;

const failures = [];
const line = (ok, msg) => {
  print(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures.push(msg);
};

const restored = {};
for (const c of d.getCollectionInfos({ type: 'collection' })) {
  if (c.name.startsWith('system.')) continue;
  restored[c.name] = {
    count: d.getCollection(c.name).countDocuments({}),
    indexes: d.getCollection(c.name).getIndexes().length,
  };
}
print(`restored ${Object.keys(restored).length} collections in ${dbName}`);

// 1. Against the manifest ---------------------------------------------------------------
// Per-collection lines are printed on failure (or always with CBI_VERBOSE=1).
const verbose = process.env.CBI_VERBOSE === '1';
if (manifest) {
  let matched = 0;
  let documents = 0;
  const names = Object.keys(manifest.collections);
  for (const name of names) {
    const expected = manifest.collections[name];
    const got = restored[name];
    if (!got) {
      line(false, `${name}: missing (manifest had ${expected.count} documents)`);
      continue;
    }
    const allowed = Math.max(tolMin, Math.ceil((expected.count * tolPct) / 100));
    const countOk = Math.abs(got.count - expected.count) <= allowed;
    const indexOk = got.indexes === expected.indexes;
    if (!countOk || verbose) {
      line(
        countOk,
        `${name}: ${got.count} documents (manifest ${expected.count}, allowed ±${allowed})`,
      );
    }
    if (!indexOk || verbose) {
      line(indexOk, `${name}: ${got.indexes} indexes (manifest ${expected.indexes})`);
    }
    if (countOk && indexOk) matched += 1;
    documents += got.count;
  }
  line(
    matched === names.length,
    `manifest: ${matched}/${names.length} collections match (documents within tolerance, same index count); ${documents} documents`,
  );
} else {
  print('no manifest: skipping count/index comparison');
}

// 2. Sanity queries ------------------------------------------------------------------------
for (const name of requireNonEmpty) {
  const n = restored[name]?.count ?? 0;
  line(n > 0, `${name}: non-empty (${n})`);
}

const userIndexes = restored.users
  ? d.users.getIndexes().map((i) => Object.keys(i.key).join(','))
  : [];
line(userIndexes.includes('primaryEmail'), 'users: unique primaryEmail index present');

if (restored.auditLogs) {
  const latest = d.auditLogs.find({}, { createdAt: 1 }).sort({ _id: -1 }).limit(1).toArray()[0];
  const when = latest && latest.createdAt ? new Date(latest.createdAt).toISOString() : 'n/a';
  line(Boolean(latest), `auditLogs: newest entry ${when}`);
}

if (process.env.CBI_REQUIRE_SUPER_ADMIN === '1') {
  const admins = d.users.countDocuments({ adminRoles: 'SUPER_ADMIN' });
  line(admins > 0, `users: ${admins} SUPER_ADMIN account(s)`);
}

if (failures.length > 0) {
  print(`VERIFY FAILED (${failures.length} check(s))`);
  quit(1);
}
print('VERIFY OK');
