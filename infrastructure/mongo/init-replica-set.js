// Idempotent MongoDB bootstrap for staging/production (run by the `mongo-init`
// compose service as the root user on every deploy):
//   1. initiates the replica set `rs0` with the members in MONGO_RS_MEMBERS
//      (default: the single node `mongo:27017`) and the optional MONGO_RS_ARBITER,
//   2. waits until the set has a PRIMARY (and connects to it when this is not it),
//   3. adds members from the HA compose profiles that are not in the set yet
//      (mongo-psa: mongo-2 + mongo-arbiter; mongo-3node: mongo-2 + mongo-3). Members
//      are never removed automatically: do that by hand with rs.remove(),
//   4. creates or updates the application user (readWrite on the app database)
//      and the backup user (built-in `backup` role, used by backup.sh).
// Passwords come from the environment (.env.datastores); updating a password
// there and re-running this script rotates it (see runbook-key-rotation.md).

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const RS_NAME = process.env.MONGO_REPLICA_SET || 'rs0';
const RS_MEMBERS = (process.env.MONGO_RS_MEMBERS || process.env.MONGO_RS_HOST || 'mongo:27017')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
const RS_ARBITER = (process.env.MONGO_RS_ARBITER || '').trim();
const APP_DB = required('MONGO_APP_DB');
const APP_USER = required('MONGO_APP_USER');
const APP_PASSWORD = required('MONGO_APP_PASSWORD');
const BACKUP_USER = required('MONGO_BACKUP_USER');
const BACKUP_PASSWORD = required('MONGO_BACKUP_PASSWORD');

// 1. Replica set
let initiated = false;
try {
  initiated = rs.status().ok === 1;
} catch (e) {
  if (!/no replset config|NotYetInitialized/i.test(String(e.message) + String(e.codeName))) throw e;
}
if (!initiated) {
  // The first member is preferred as primary; an arbiter holds no data.
  const members = RS_MEMBERS.map((host, i) => ({ _id: i, host, priority: i === 0 ? 2 : 1 }));
  if (RS_ARBITER) members.push({ _id: members.length, host: RS_ARBITER, arbiterOnly: true });
  print(`initiating replica set ${RS_NAME} with members ${members.map((m) => m.host).join(', ')}`);
  rs.initiate({ _id: RS_NAME, members });
}

// 2. Wait for a PRIMARY (up to 60 s); after a failover it may be another member.
const deadline = Date.now() + 60000;
let hello = db.hello();
while (!hello.isWritablePrimary && !hello.primary) {
  if (Date.now() > deadline) throw new Error('replica set did not elect a primary within 60 s');
  sleep(1000);
  hello = db.hello();
}
if (!hello.isWritablePrimary) {
  print(`this node is not primary; continuing on ${hello.primary}`);
  const user = encodeURIComponent(required('MONGO_INITDB_ROOT_USERNAME'));
  const pwd = encodeURIComponent(required('MONGO_INITDB_ROOT_PASSWORD'));
  db = connect(`mongodb://${user}:${pwd}@${hello.primary}/admin?directConnection=true`);
}

// 3. Members added by an HA profile since the set was initiated
const present = new Set(rs.conf().members.map((m) => m.host));
for (const host of RS_MEMBERS) {
  if (present.has(host)) continue;
  print(`adding member ${host}`);
  rs.add({ host, priority: 1 });
}
if (RS_ARBITER && !present.has(RS_ARBITER)) {
  // MongoDB refuses an arbiter while the default write concern is implicit. w:1 is what a
  // PSA set would default to; majority would block writes whenever the secondary is down.
  db.adminCommand({ setDefaultRWConcern: 1, defaultWriteConcern: { w: 1 } });
  print(`adding arbiter ${RS_ARBITER}`);
  rs.addArb(RS_ARBITER);
}
const wanted = new Set([...RS_MEMBERS, ...(RS_ARBITER ? [RS_ARBITER] : [])]);
for (const host of present) {
  if (!wanted.has(host))
    print(`WARNING: ${host} is in the replica set but not in MONGO_RS_MEMBERS`);
}

// 4. Users (create, or update password/roles so re-runs converge)
function upsertUser(dbName, user, pwd, roles) {
  const target = db.getSiblingDB(dbName);
  if (target.getUser(user)) {
    target.updateUser(user, { pwd, roles });
    print(`updated user ${user}@${dbName}`);
  } else {
    target.createUser({ user, pwd, roles });
    print(`created user ${user}@${dbName}`);
  }
}

upsertUser(APP_DB, APP_USER, APP_PASSWORD, [{ role: 'readWrite', db: APP_DB }]);
upsertUser('admin', BACKUP_USER, BACKUP_PASSWORD, [{ role: 'backup', db: 'admin' }]);

print(`mongo-init complete: replica set ${RS_NAME} has a primary, users ready`);
