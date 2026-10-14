/// <reference types="vite/client" />

declare global {
  /** VITE_API_ORIGIN, validated in vite.config.ts and substituted at build. */
  const __VITRINA_API_ORIGIN__: string;
}

export {};
