-- Prestep for "Sign in with Steam": a display name slot on player. Until a
-- verified Steam OpenID flow sets it, players render as an anonymous label
-- derived from their hash. The hash stays the primary key either way, so
-- sign-in later just claims/annotates an existing row.
ALTER TABLE player ADD COLUMN display_name TEXT;
