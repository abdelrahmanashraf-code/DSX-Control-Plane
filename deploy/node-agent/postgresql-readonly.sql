-- DSX Node Agent PostgreSQL inventory role.
-- Intended for a NON-PRODUCTION node first.
-- Authentication is expected to use the local Unix socket with PostgreSQL peer auth,
-- matching the Linux service user `dsx-agent`. No password is created or stored.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dsx-agent') THEN
        CREATE ROLE "dsx-agent"
            LOGIN
            NOSUPERUSER
            NOCREATEDB
            NOCREATEROLE
            NOREPLICATION
            CONNECTION LIMIT 5;
    END IF;
END
$$;

ALTER ROLE "dsx-agent"
    NOSUPERUSER
    NOCREATEDB
    NOCREATEROLE
    NOREPLICATION
    CONNECTION LIMIT 5;

ALTER ROLE "dsx-agent" SET statement_timeout = '5s';
ALTER ROLE "dsx-agent" SET lock_timeout = '1s';

GRANT CONNECT ON DATABASE postgres TO "dsx-agent";
GRANT pg_read_all_stats TO "dsx-agent";
