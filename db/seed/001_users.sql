-- Demo users (dev-login accepts these emails when DEMO_MODE=1). Idempotent.
INSERT INTO users (name, email, role) VALUES
    ('Alex Morgan', 'manager@demo.local', 'manager'),
    ('Jordan Lee', 'rep1@demo.local', 'rep'),
    ('Priya Shah', 'rep2@demo.local', 'rep'),
    ('Sam Rivera', 'rep3@demo.local', 'rep')
ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role;
