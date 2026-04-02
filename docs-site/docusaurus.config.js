// @ts-check

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'CostKey',
  tagline: 'Sentry for AI costs',
  favicon: 'img/favicon.svg',

  url: 'https://docs.costkey.dev',
  baseUrl: '/',

  organizationName: 'costkey',
  projectName: 'costkey',

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.js',
          editUrl: 'https://github.com/costkey/costkey/tree/main/docs-site/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: {
        defaultMode: 'dark',
        disableSwitch: false,
        respectPrefersColorScheme: false,
      },
      navbar: {
        title: 'CostKey',
        logo: {
          alt: 'CostKey Logo',
          src: 'img/favicon.svg',
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docs',
            position: 'left',
            label: 'Docs',
          },
          {
            href: 'https://github.com/costkey/costkey',
            label: 'GitHub',
            position: 'right',
          },
          {
            href: 'https://app.costkey.dev',
            label: 'Dashboard',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Getting Started', to: '/' },
              { label: 'Python SDK', to: '/python-sdk' },
              { label: 'TypeScript SDK', to: '/typescript-sdk' },
            ],
          },
          {
            title: 'More',
            items: [
              { label: 'GitHub', href: 'https://github.com/costkey/costkey' },
              { label: 'npm', href: 'https://www.npmjs.com/package/costkey' },
              { label: 'PyPI', href: 'https://pypi.org/project/costkey/' },
            ],
          },
        ],
        copyright: `Copyright ${new Date().getFullYear()} CostKey. MIT License.`,
      },
      prism: {
        theme: require('prism-react-renderer').themes.vsDark,
        darkTheme: require('prism-react-renderer').themes.vsDark,
        additionalLanguages: ['bash', 'json', 'yaml', 'docker'],
      },
    }),
};

module.exports = config;
