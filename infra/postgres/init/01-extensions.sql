-- Runs once, on first initialisation of an empty data volume
-- (docker-entrypoint-initdb.d). To re-run it: pnpm infra:reset
--
-- PostGIS powers every geospatial query in SPEC.md: vendor serviceability
-- (radius x 1.1 drift buffer), NP polygon tenant checks, and GiST-indexed points.
CREATE EXTENSION IF NOT EXISTS postgis;
