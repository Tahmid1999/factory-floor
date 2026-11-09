import type { NextConfig } from 'next';

// The portfolio embeds /admin and /hood in an iframe; this is the host list
// Live Room settled on. The phone station is never framed.
const EMBEDDERS =
  'frame-ancestors https://tahmidalavi.netlify.app https://v2--tahmidalavi.netlify.app https://tahmidalavi.com http://localhost:3530';

const csp = (value: string) => [{ key: 'Content-Security-Policy', value }];

const config: NextConfig = {
  async headers() {
    // Rules that match the same path would merge into one header with two
    // policies, and the browser applies both. So the catch-all leaves the two
    // embeddable trees out.
    return [
      { source: '/admin/:path*', headers: csp(EMBEDDERS) },
      { source: '/hood', headers: csp(EMBEDDERS) },
      { source: '/((?!admin|hood).*)', headers: csp("frame-ancestors 'none'") },
    ];
  },
};

export default config;
