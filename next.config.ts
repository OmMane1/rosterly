import type { NextConfig } from 'next';

// Browser auth is same-origin (PLAN.md A17): the browser talks to /supabase/*, and Next forwards it
// to local Supabase, so signing in also works from a phone on the LAN, where 127.0.0.1 would be the
// phone itself. SUPABASE_URL comes from .env.local (make setup), which Next loads before this file.
const SUPABASE_URL = (process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321').replace(/\/$/, '');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/supabase/:path*', destination: `${SUPABASE_URL}/:path*` }];
  },
};

export default nextConfig;
