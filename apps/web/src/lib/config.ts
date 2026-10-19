export const TILE_URL = import.meta.env.VITE_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION =
  import.meta.env.VITE_TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * Demo mode signs in silently through POST /auth/dev-login and lets anyone switch user from the user menu.
 * Off (VITE_DEMO_MODE=false) the app expects a real identity provider; see auth/guards.tsx.
 */
export const DEMO_MODE = String(import.meta.env.VITE_DEMO_MODE ?? 'true').toLowerCase() !== 'false';
export const DEFAULT_DEMO_USER = String(import.meta.env.VITE_DEFAULT_DEMO_USER || 'rep1@demo.local').trim().toLowerCase();
