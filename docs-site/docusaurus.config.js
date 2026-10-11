// @ts-check

const { themes } = require('prism-react-renderer');

/** One Dark syntax colours on the Ink code surface from the design language. */
const inkCodeTheme = { ...themes.oneDark, plain: { ...themes.oneDark.plain, backgroundColor: '#182B45' } };

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'CostKey',
  tagline: 'Your AI spend, in sight',
  favicon: 'img/favicon.svg',

  url: 'https://costkey.dev',
  baseUrl: '/docs/',

  organizationName: 'costkey',
  projectName: 'costkey',

  onBrokenLinks: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

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
        defaultMode: 'light',
        disableSwitch: true,
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
            to: '/self-hosting',
            label: 'Self-host',
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
              { label: 'Getting started', to: '/' },
              { label: 'Python SDK', to: '/python-sdk' },
              { label: 'TypeScript SDK', to: '/typescript-sdk' },
              { label: 'Recipes & diagnostics', to: '/recipes' },
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
        theme: inkCodeTheme,
        darkTheme: inkCodeTheme,
        additionalLanguages: ['bash', 'json', 'yaml', 'docker'],
      },
    }),
};

module.exports = config;
