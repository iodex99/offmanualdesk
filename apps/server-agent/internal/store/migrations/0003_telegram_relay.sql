-- Telegram relay (ADR-023): the Server Agent connects to an employee's gateway as a
-- client, so it keeps the lease token DPAPI-protected (machine scope; agent.db is
-- SYSTEM + Administrators only, ADR-033). The hash stays for verification.
ALTER TABLE leases ADD COLUMN token_dpapi BLOB;
