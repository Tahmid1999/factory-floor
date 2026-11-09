-- The app role must not be able to rewrite history, even through a bug or an
-- injection, so AuditLog is append-only for ff_app.
GRANT USAGE ON SCHEMA public TO ff_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ff_app;
REVOKE UPDATE, DELETE ON "AuditLog" FROM ff_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ff_app;
