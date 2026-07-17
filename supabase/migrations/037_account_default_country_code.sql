ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS default_country_code TEXT NOT NULL DEFAULT '+57';

ALTER TABLE accounts
  ADD CONSTRAINT accounts_default_country_code_format
  CHECK (default_country_code ~ '^\+[1-9][0-9]{0,3}$');
