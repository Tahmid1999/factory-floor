// Test-only owner login for the e2e API. The stack, the db reset and the admin
// spec all read it from here so they cannot drift apart.
module.exports = {
  ADMIN_PASSWORD: 'e2e-admin-password',
  ADMIN_JWT_SECRET: 'e2e-only-admin-jwt-secret',
};
