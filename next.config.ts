import type { NextConfig } from "next";
const nextConfig: NextConfig = { poweredByHeader: false, serverExternalPackages: ["postgres"],
  async headers() { return [{source:"/(.*)", headers:[
    {key:"X-Content-Type-Options",value:"nosniff"}, {key:"Referrer-Policy",value:"strict-origin-when-cross-origin"},
    {key:"X-Frame-Options",value:"DENY"}, {key:"Permissions-Policy",value:"camera=(), microphone=(), geolocation=()"}
  ]},
  // Pages and API responses carry a member's company data: never store them, so Back after signing out cannot
  // show the workspace from the browser's cache. Hashed build assets under /_next/ and the favicon stay cacheable.
  // (`next dev` replaces this on pages with its own `no-cache`; production keeps it.)
  {source:"/((?!_next/|favicon\\.svg).*)", headers:[
    {key:"Cache-Control",value:"private, no-cache, no-store, max-age=0, must-revalidate"}
  ]},
  // Signing out also empties this site's browser cache, so pages cached earlier (including under `next dev`)
  // cannot be shown again with Back.
  {source:"/auth/signout", headers:[
    {key:"Clear-Site-Data",value:"\"cache\""}
  ]}]; }
};
export default nextConfig;
