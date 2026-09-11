const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

const DEV_RELOAD_PORT = Number(process.env.NMA_DEV_PORT || 9012);
const DEV_RELOAD_ORIGIN = 'http://127.0.0.1:' + DEV_RELOAD_PORT + '/*';
const DEV_GECKO_ID = 'nexus-mods-assistant-dev@alkearilabs.com';

function transformManifest(content, options) {
    const manifest = JSON.parse(content.toString('utf8'));
    if (!options.isDev) {
        return Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    }
    manifest.name = manifest.name + ' (Dev)';
    manifest.version_name = manifest.version + '-dev';
    if (options.useReloader) {
        manifest.host_permissions = (manifest.host_permissions || []).concat([DEV_RELOAD_ORIGIN]);
    }
    if (manifest.browser_specific_settings && manifest.browser_specific_settings.gecko) {
        manifest.browser_specific_settings.gecko.id = DEV_GECKO_ID;
    }
    return Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

module.exports = (env, argv) => {
    const browser = process.env.BROWSER || 'chrome';
    const isDev = (argv && argv.mode) === 'development';
    const useReloader = isDev && browser === 'chrome' && process.env.NMA_DEV_RELOAD !== '0';
    const manifestSource = browser === 'firefox' ? 'manifests/firefox.json' : 'manifests/chrome.json';

    const plugins = [
        new CopyPlugin({
            patterns: [
                {
                    from: manifestSource,
                    to: 'manifest.json',
                    transform: (content) => transformManifest(content, { isDev: isDev, useReloader: useReloader })
                },
                { from: 'src/assets/icons', to: 'icons' },
                // _locales must sit at the package root: the browser resolves __MSG_*__ and
                // chrome.i18n.getMessage against <root>/_locales/<locale>/messages.json.
                {
                    from: 'src/_locales',
                    to: '_locales',
                    // parts/ and seed.json are the inputs npm run locales merges into
                    // en/messages.json. The browser reads only _locales/<locale>/messages.json, so
                    // shipping them adds a copy of every translator note to the artifact and tells
                    // a store reviewer nothing. Build inputs stay out of the build output.
                    globOptions: { ignore: ['**/parts/**', '**/seed.json'] }
                },
                { from: 'src/popup/popup.html', to: 'popup/popup.html' },
                { from: 'src/popup/popup.css', to: 'popup/popup.css' },
                { from: 'src/content/content.css', to: 'content/content.css' }
            ]
        })
    ];

    if (useReloader) {
        plugins.push(new webpack.DefinePlugin({
            __NMA_DEV_PORT__: JSON.stringify(DEV_RELOAD_PORT)
        }));
    }

    return {
        mode: (argv && argv.mode) || 'production',
        entry: {
            // The reloader is in the entry array only in development mode, so it cannot
            // reach a production bundle by any flag. preflight.js asserts its absence
            // independently by scanning the built output for the NMA_DEV_RELOAD marker.
            background: useReloader
                ? ['./src/dev/reloader.ts', './src/background/background.ts']
                : './src/background/background.ts',
            content: './src/content/content.ts',
            popup: './src/popup/popup.ts'
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    use: 'ts-loader',
                    exclude: /node_modules/
                }
            ]
        },
        resolve: {
            extensions: ['.ts', '.js']
        },
        // MV3's extension_pages CSP cannot be relaxed to allow unsafe-eval, so every
        // eval-based devtool produces a build the browser refuses to run.
        devtool: isDev ? 'inline-cheap-module-source-map' : false,
        output: {
            filename: '[name]/[name].js',
            path: path.resolve(__dirname, 'dist-' + browser),
            // Wiping the directory on every watch rebuild races the browser's file reads
            // and drops the unpacked extension entry.
            clean: !isDev
        },
        plugins: plugins,
        optimization: {
            // Minified in production, readable in development. Chrome's code readability
            // policy permits minification explicitly: removing whitespace, shortening
            // names and collapsing files. It prohibits obfuscation, so nothing here may
            // ever go further than this, and mangling is left at its default rather than
            // pushed toward concealment. A published extension is a zip that any user can
            // read from disk; minification raises the effort, it does not make the source
            // private, and nothing in this build should be written as though it does.
            minimize: !isDev
        },
        infrastructureLogging: { level: 'warn' },
        stats: 'errors-warnings'
    };
};
