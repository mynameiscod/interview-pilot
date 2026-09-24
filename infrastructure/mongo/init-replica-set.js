// Idempotent MongoDB bootstrap for staging/production (run by the `mongo-init`
// compose service as the root user on every deploy):
//   1. initiates the single-node replica set `rs0` (member host `mongo:27017`),
//   2. waits until this node is PRIMARY,
//   3. creates or updates the application user (readWrite on the app database)
//      and the backup user (built-in `backup` role, used by backup.sh).
// Passwords come from the environment (.env.datastores); updating a password
// there and re-running this script rotates it (see runbook-key-rotation.md).

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const RS_NAME = process.env.MONGO_REPLICA_SET || 'rs0';
const RS_HOST = process.env.MONGO_RS_HOST || 'mongo:27017';
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
  print(`initiating replica set ${RS_NAME} with member ${RS_HOST}`);
  rs.initiate({ _id: RS_NAME, members: [{ _id: 0, host: RS_HOST }] });
}

// 2. Wait for PRIMARY (up to 60 s)
const deadline = Date.now() + 60000;
while (!db.hello().isWritablePrimary) {
  if (Date.now() > deadline) throw new Error('replica set did not elect a primary within 60 s');
  sleep(1000);
}

// 3. Users (create, or update password/roles so re-runs converge)
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

print(`mongo-init complete: replica set ${RS_NAME} primary, users ready`);
