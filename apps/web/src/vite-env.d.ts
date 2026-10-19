/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TILE_URL?: string;
  readonly VITE_TILE_ATTRIBUTION?: string;
  /** 'false' turns off the silent demo sign-in and the Switch user menu. */
  readonly VITE_DEMO_MODE?: string;
  readonly VITE_DEFAULT_DEMO_USER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
