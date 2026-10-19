// The seeded demo accounts (db/seed/001_users.sql), offered by "Switch user" in demo mode.
import type { Role } from '@/api/types';

export interface DemoUser {
  email: string;
  name: string;
  role: Role;
}

export const DEMO_USERS: readonly DemoUser[] = [
  { email: 'manager@demo.local', name: 'Alex Morgan', role: 'manager' },
  { email: 'rep1@demo.local', name: 'Jordan Lee', role: 'rep' },
  { email: 'rep2@demo.local', name: 'Priya Shah', role: 'rep' },
  { email: 'rep3@demo.local', name: 'Sam Rivera', role: 'rep' },
];

export const roleLabel = (role: Role) => (role === 'manager' ? 'Manager' : 'Sales rep');
