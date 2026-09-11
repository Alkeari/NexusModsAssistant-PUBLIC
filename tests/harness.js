'use strict';

/**
 * Lets node:test import the extension's TypeScript modules directly, with no build step
 * and no change to any src file.
 *
 * Node's own type stripping is not enough here for three reasons, all of them properties
 * of src/ rather than of the test suite:
 *   1. src/ uses extensionless relative specifiers ('./errors'), which Node's ESM resolver
 *      does not extend with '.ts'.
 *   2. Four modules import a type through a value import, which strip-only mode turns into
 *      a missing named export at runtime.
 *   3. src/content/lifecycle.ts uses a parameter property, which strip-only mode refuses.
 * Running the real TypeScript compiler in transpile-only mode answers all three. It is the
 * same compiler version ts-loader uses, driven from the repository's own tsconfig.json, so
 * the emit under test matches the shipped emit. Only `module` is overridden, to ESNext, so
 * the output is always ESM regardless of what the bundle is configured to emit.
 *
 * require() this module BEFORE the dynamic import() of anything under src/. Hooks are
 * registered on the current thread, and node --test runs each test file in its own
 * process, so every file that needs src/ must require it for itself.
 */

const fs = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let ts = null;
let tsLoadError = null;
try {
    ts = require('typescript');
} catch (err) {
    tsLoadError = err;
}

function isInsideSrc(file) {
    const rel = path.relative(SRC, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Taken from the repository tsconfig rather than restated here, because a target or a
// class-field setting that differs between the suite and the bundle would let a test pass
// against an emit the browser never receives.
function compilerOptions() {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
    const converted = ts.convertCompilerOptionsFromJson(raw.compilerOptions || {}, ROOT);
    return {
        ...converted.options,
        module: ts.ModuleKind.ESNext,
        outDir: undefined,
        rootDir: undefined,
        declaration: false,
        sourceMap: false,
        inlineSourceMap: false
    };
}

let options = null;
let registered = false;

function register() {
    if (registered) return;
    registered = true;

    registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier.startsWith('.') && !path.extname(specifier)) {
                const parentUrl = context.parentURL;
                if (parentUrl && parentUrl.startsWith('file:')) {
                    const base = path.dirname(fileURLToPath(parentUrl));
                    const target = path.resolve(base, specifier);
                    for (const candidate of [`${target}.ts`, path.join(target, 'index.ts')]) {
                        if (isInsideSrc(candidate) && fs.existsSync(candidate)) {
                            return { url: pathToFileURL(candidate).href, format: 'module', shortCircuit: true };
                        }
                    }
                }
            }
            return nextResolve(specifier, context);
        },

        load(url, context, nextLoad) {
            if (!url.startsWith('file:') || !url.endsWith('.ts')) {
                return nextLoad(url, context);
            }
            const file = fileURLToPath(url);
            if (!isInsideSrc(file)) {
                return nextLoad(url, context);
            }
            if (!ts) {
                throw new Error('tests/harness.js needs the typescript devDependency: ' +
                    (tsLoadError ? tsLoadError.message : 'not installed'));
            }
            if (!options) options = compilerOptions();
            const emitted = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
                fileName: file,
                reportDiagnostics: false,
                compilerOptions: options
            });
            return { format: 'module', shortCircuit: true, source: emitted.outputText };
        }
    });
}

register();

/**
 * Node has no `chrome`, and every user-facing string now goes through `chrome.i18n.getMessage`.
 * Without this, importing any module that renders text throws on the first lookup.
 *
 * The stub is backed by the real English catalog rather than by a map written for the tests, and it
 * substitutes placeholders the way Chrome does. That is deliberate: a test asserting
 * "Nexus is not responding right now (HTTP 503)." is then asserting the sentence that actually
 * ships, so the assertions keep the meaning they had before the strings moved into the catalog. A
 * stub returning the key would have made all of them pass while proving nothing.
 */
function installI18n() {
    if (globalThis.chrome && globalThis.chrome.i18n) {
        return;
    }
    const catalogPath = path.join(ROOT, 'src', '_locales', 'en', 'messages.json');
    const catalog = fs.existsSync(catalogPath)
        ? JSON.parse(fs.readFileSync(catalogPath, 'utf8').replace(/^﻿/, ''))
        : {};
    globalThis.chrome = Object.assign(globalThis.chrome || {}, {
        i18n: {
            getMessage(key, substitutions) {
                const entry = catalog[key];
                if (!entry) {
                    return '';
                }
                const subs = substitutions === undefined ? []
                    : (Array.isArray(substitutions) ? substitutions : [substitutions]);
                let text = entry.message;
                for (const [name, spec] of Object.entries(entry.placeholders || {})) {
                    const index = Number(String(spec.content).replace('$', '')) - 1;
                    const value = subs[index] === undefined ? '' : String(subs[index]);
                    text = text.split('$' + name.toUpperCase() + '$').join(value);
                    text = text.split('$' + name + '$').join(value);
                }
                return text;
            }
        }
    });
}

installI18n();

/**
 * Import a module by repository-relative path. Returns the namespace object.
 */
async function importSrc(relativePath) {
    const abs = path.join(ROOT, relativePath);
    return import(pathToFileURL(abs).href);
}

module.exports = { ROOT, importSrc, typescriptAvailable: ts !== null };
