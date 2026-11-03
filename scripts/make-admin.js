// Gives an existing account access to the admin inbox, or removes it.
// Usage: node scripts/make-admin.js <email or +phone> [--remove]
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const db = require('../db');

const [arg, flag] = process.argv.slice(2);
if (!arg) {
  console.error('Usage: node scripts/make-admin.js <email or +phone> [--remove]');
  process.exit(1);
}

const identifier = arg.includes('@')
  ? { kind: 'email', value: arg.trim().toLowerCase() }
  : { kind: 'phone', value: parsePhoneNumberFromString(arg)?.number };
const user = identifier.value && db.userByIdentifier(identifier);
if (!user) {
  console.error(`No account found for ${arg}. Phone numbers need the country code, e.g. +447911123456.`);
  process.exit(1);
}

const makeAdmin = flag !== '--remove';
db.setAdmin(user.id, makeAdmin);
console.log(`${arg} is ${makeAdmin ? 'now an admin' : 'no longer an admin'}.`);
