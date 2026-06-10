-- Extend statement timeout for migration RPCs to 60 seconds
-- This is per-function override, doesn't change global setting
ALTER ROLE authenticator SET statement_timeout TO '60000';
