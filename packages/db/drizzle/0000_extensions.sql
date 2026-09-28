-- PostGIS: geometry types, spatial functions and GiST operator classes used by 0001.
-- Idempotent, because the local docker init script (infra/postgres/init) may already have
-- created it. Managed databases (e.g. AWS RDS) need it created here.
CREATE EXTENSION IF NOT EXISTS postgis;
