import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  webpack: (config) => {
    // Suppress "useEffectEvent is not exported" errors in fumadocs
    // This is a known issue with React canary + webpack
    config.module.exprContextCritical = false;
    return config;
  },
};

export default withMDX(config);
