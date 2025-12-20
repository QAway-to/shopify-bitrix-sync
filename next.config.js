/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  webpack: (config, { isServer }) => {
    // Handle JSON imports with assert { type: 'json' }
    config.module.rules.push({
      test: /\.json$/,
      type: 'json',
    });
    
    // Ignore missing modules that may be referenced but not actually imported
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      crypto: false,
    };
    
    return config;
  },
}

module.exports = nextConfig

