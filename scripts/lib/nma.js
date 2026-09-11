'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(ROOT, '.nma-state');
const RESULT_MARKER = 'NMA_RESULT ';

const EXIT = {
    OK: 0,
    FAILED: 1,
    PREFLIGHT: 2,
    STORE_BUSY: 3,
    CREDENTIALS: 4,
    NETWORK: 5,
    PARTIAL: 6,
    REFUSED: 7
};

const CHROME_ITEM_ID = 'hflkcljgifgjdlpgibmldlpkpjhjdddf';
const AMO_ADDON_GUID = 'nexus-mods-assistant@alkearilabs.com';
// The extension is also listed as a mod on Nexus Mods. Nexus exposes no API for
// uploading a file version, so that destination is manual and easy to forget:
// every release surfaces it in the closing summary.
const NEXUS_LISTING = 'https://www.nexusmods.com/site/mods/1588';
const CHROME_DASHBOARD = 'https://chrome.google.com/webstore/devconsole';
const CHROME_LISTING = 'https://chromewebstore.google.com/detail/' + CHROME_ITEM_ID;
const AMO_DASHBOARD = 'https://addons.mozilla.org/en-US/developers/addon/nexus-mods-assistant/versions';
const AMO_LISTING = 'https://addons.mozilla.org/en-US/firefox/addon/nexus-mods-assistant/';

let resultEmitted = false;

function log(msg) {
    process.stdout.write('[nma] ' + msg + '\n');
}

function step(msg) {
    process.stdout.write('[nma] ---- ' + msg + '\n');
}

function warn(msg) {
    process.stdout.write('[nma] WARN  ' + msg + '\n');
}

function errline(msg) {
    process.stderr.write('[nma] ERROR ' + msg + '\n');
}

function buildResult(result) {
    return Object.assign({
        schema: 1,
        script: 'unknown',
        ok: false,
        target: null,
        version: null,
        action: null,
        artifact: null,
        changed: [],
        store: null,
        state: null,
        url: null,
        durationMs: 0,
        warnings: [],
        errors: [],
        nextStep: null
    }, result);
}

// fs.writeSync on fd 1 is synchronous whatever stdout is attached to. process.stdout.write
// is asynchronous on a Windows TTY, so process.exit() immediately afterwards can drop the
// one line the whole agent contract depends on.
function writeResult(result) {
    const line = RESULT_MARKER + JSON.stringify(buildResult(result)) + '\n';
    try {
        fs.writeSync(1, line);
    } catch (err) {
        void err;
        process.stdout.write(line);
    }
}

function emit(result) {
    if (resultEmitted) {
        return;
    }
    resultEmitted = true;
    writeResult(result);
}

function isFinished(err) {
    return Boolean(err) && err.__nmaFinished === true;
}

// process.exit() after any fetch() trips a libuv assertion on Windows
// ("!(handle->flags & UV_HANDLE_CLOSING)") and reports exit code 3221226505 instead of
// the real one, which would silently break the whole exit code contract. Destroying the
// global dispatcher and letting the loop drain is the only sequence that reports the
// intended code. Verified on Node v25.4.0.
function releaseHandles() {
    try {
        const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
        if (dispatcher && typeof dispatcher.destroy === 'function') {
            void dispatcher.destroy();
        }
    } catch (err) {
        void err;
    }
}

// Terminal. Unwinds the caller by throwing, so no statement after a finish() call ever
// runs, and is idempotent: a catch frame that calls finish() again cannot overwrite the
// result or the exit code that was already reported.
function finish(result, exitCode) {
    if (!resultEmitted) {
        const code = typeof exitCode === 'number' ? exitCode : (result.ok ? EXIT.OK : EXIT.FAILED);
        emit(result);
        process.exitCode = code;
        releaseHandles();
        // Nothing should still be holding the loop open, but a long lived script such as
        // dev.js can be. Unref'd, so it never delays an otherwise clean exit.
        const watchdog = setTimeout(() => {
            process.exit(code);
        }, 3000);
        watchdog.unref();
    }
    const stop = new Error('nma: terminated');
    stop.__nmaFinished = true;
    throw stop;
}

function guard(script, startedAt) {
    const bail = (err) => {
        if (isFinished(err)) {
            return;
        }
        const message = err && err.stack ? err.stack : String(err);
        errline(message);
        finish({
            script: script,
            ok: false,
            state: 'crashed',
            errors: [String((err && err.message) || err)],
            durationMs: Date.now() - startedAt,
            nextStep: 'Read the stack trace above. Nothing was published by this run.'
        }, (err && err.exitCode) || EXIT.FAILED);
    };
    process.on('uncaughtException', bail);
    process.on('unhandledRejection', bail);
}

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            out._.push(token);
            continue;
        }
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            out[key] = true;
        } else {
            out[key] = next;
            i++;
        }
    }
    return out;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function ensureStateDir() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readState(name, fallback) {
    const file = path.join(STATE_DIR, name);
    if (!fs.existsSync(file)) {
        return fallback;
    }
    try {
        return readJson(file);
    } catch (err) {
        warn('State file ' + name + ' is unreadable, treating as absent: ' + err.message);
        return fallback;
    }
}

function writeState(name, value) {
    ensureStateDir();
    const copy = Object.assign({}, value);
    delete copy.__file;
    writeJson(path.join(STATE_DIR, name), copy);
}

function pidAlive(pid) {
    if (!pid) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// The lock exists so two agent invocations of the hot path cannot interleave
// webpack writes into the same dist folder.
async function acquireLock(name, waitMs) {
    ensureStateDir();
    const file = path.join(STATE_DIR, name + '.lock');
    const deadline = Date.now() + (waitMs || 0);
    for (;;) {
        try {
            fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
            return () => {
                try {
                    fs.unlinkSync(file);
                } catch (err) {
                    void err;
                }
            };
        } catch (err) {
            if (err.code !== 'EEXIST') {
                throw err;
            }
            let held = null;
            try {
                held = readJson(file);
            } catch (parseErr) {
                void parseErr;
            }
            const stale = !held || (Date.now() - held.at) > 600000 || !pidAlive(held.pid);
            if (stale) {
                try {
                    fs.unlinkSync(file);
                } catch (unlinkErr) {
                    void unlinkErr;
                }
                continue;
            }
            if (Date.now() >= deadline) {
                throw new Error('Lock ' + name + ' held by pid ' + held.pid + ' since ' + new Date(held.at).toISOString());
            }
            await sleep(500);
        }
    }
}

function quoteArg(value) {
    return '"' + String(value).replace(/"/g, '\\"') + '"';
}

// Windows needs shell:true to launch a .cmd shim, and this repo path contains spaces,
// so every token is quoted. A newline inside an argument terminates the cmd.exe command
// line and silently truncates it with exit code 0, so it is rejected outright here.
function run(command, args, options) {
    const opts = options || {};
    for (const arg of args) {
        if (/[\r\n]/.test(String(arg))) {
            throw new Error('Refusing to pass a multi-line argument through a shell: it is silently truncated on Windows. Use runDirect or a -F file.');
        }
    }
    return new Promise((resolve) => {
        const line = [command].concat(args).map(quoteArg).join(' ');
        const child = spawn(line, {
            cwd: opts.cwd || ROOT,
            shell: true,
            stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
            env: Object.assign({}, process.env, opts.env || {}),
            windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        if (opts.capture) {
            child.stdout.on('data', (chunk) => {
                stdout += chunk;
                if (opts.echo) {
                    process.stdout.write(chunk);
                }
            });
            child.stderr.on('data', (chunk) => {
                stderr += chunk;
                if (opts.echo) {
                    process.stderr.write(chunk);
                }
            });
        }
        let timer = null;
        if (opts.timeoutMs) {
            timer = setTimeout(() => {
                child.kill();
                resolve({ code: 124, stdout: stdout, stderr: stderr + '\ntimed out after ' + opts.timeoutMs + 'ms' });
            }, opts.timeoutMs);
        }
        child.on('error', (err) => {
            if (timer) {
                clearTimeout(timer);
            }
            resolve({ code: 1, stdout: stdout, stderr: stderr + err.message });
        });
        child.on('close', (code) => {
            if (timer) {
                clearTimeout(timer);
            }
            resolve({ code: code === null ? 1 : code, stdout: stdout, stderr: stderr });
        });
    });
}

// No shell. Arguments are passed as an argv array, so nothing is parsed or truncated.
// Only usable for real executables, not .cmd shims.
function runDirect(command, args, options) {
    const opts = options || {};
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd: opts.cwd || ROOT,
            shell: false,
            stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
            env: Object.assign({}, process.env, opts.env || {}),
            windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        if (opts.capture) {
            child.stdout.on('data', (chunk) => {
                stdout += chunk;
                if (opts.echo) {
                    process.stdout.write(chunk);
                }
            });
            child.stderr.on('data', (chunk) => {
                stderr += chunk;
                if (opts.echo) {
                    process.stderr.write(chunk);
                }
            });
        }
        child.on('error', (err) => resolve({ code: 1, stdout: stdout, stderr: stderr + err.message }));
        child.on('close', (code) => resolve({ code: code === null ? 1 : code, stdout: stdout, stderr: stderr }));
    });
}

function binPath(name) {
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    return path.join(ROOT, 'node_modules', '.bin', name + suffix);
}

function requireBin(name) {
    const file = binPath(name);
    if (!fs.existsSync(file)) {
        throw Object.assign(
            new Error('Required tool "' + name + '" is not installed. Expected ' + file + '. Run: npm install'),
            { exitCode: EXIT.PREFLIGHT }
        );
    }
    return file;
}

function runBin(name, args, options) {
    return run(requireBin(name), args, options);
}

function runNpm(args, options) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return run(npm, args, options);
}

function runGit(args, options) {
    return runDirect('git', args, Object.assign({ capture: true }, options || {}));
}

function runNode(args, options) {
    return runDirect(process.execPath, args, options);
}

function writeTempFile(name, contents) {
    ensureStateDir();
    const file = path.join(STATE_DIR, name);
    fs.writeFileSync(file, contents, 'utf8');
    return file;
}

function parseVersion(value) {
    if (typeof value !== 'string' && typeof value !== 'number') {
        return null;
    }
    const parts = String(value).split('.');
    if (parts.length < 1 || parts.length > 4) {
        return null;
    }
    const nums = [];
    for (const part of parts) {
        if (!/^(0|[1-9][0-9]*)$/.test(part)) {
            return null;
        }
        const n = Number(part);
        if (n > 65535) {
            return null;
        }
        nums.push(n);
    }
    if (nums.every((n) => n === 0)) {
        return null;
    }
    return nums;
}

function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) {
        throw new Error('Cannot compare versions: ' + a + ' and ' + b);
    }
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const l = left[i] || 0;
        const r = right[i] || 0;
        if (l !== r) {
            return l < r ? -1 : 1;
        }
    }
    return 0;
}

function bumpVersion(current, level) {
    const parts = parseVersion(current);
    if (!parts) {
        throw new Error('Unparseable current version: ' + current);
    }
    while (parts.length < 3) {
        parts.push(0);
    }
    if (level === 'major') {
        return [parts[0] + 1, 0, 0].join('.');
    }
    if (level === 'minor') {
        return [parts[0], parts[1] + 1, 0].join('.');
    }
    if (level !== 'patch') {
        throw new Error('Unknown bump level: ' + level + '. Use patch, minor or major.');
    }
    return [parts[0], parts[1], parts[2] + 1].join('.');
}

function credentialsPath() {
    return process.env.NMA_CREDENTIALS || path.join(os.homedir(), '.alkeari', 'nma-publish.env');
}

function loadCredentials() {
    const file = credentialsPath();
    const values = {};
    if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) {
                continue;
            }
            const eq = line.indexOf('=');
            if (eq < 0) {
                continue;
            }
            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim();
            // Repeatedly, not once. The template ships an empty pair of quotes for
            // the private key, and pasting a JSON value that is itself quoted
            // leaves a stray quote behind. One pass removes the outer pair and
            // leaves the inner one inside the value, where it corrupts a PEM into
            // something OpenSSL rejects with an error naming none of this.
            let stripped = true;
            while (stripped && value.length >= 2) {
                stripped = false;
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1).trim();
                    stripped = true;
                }
            }
            values[key] = value.replace(/\\n/g, '\n');
        }
    }
    // A real environment variable wins, so CI or a one-off override needs no file edit.
    for (const key of Object.keys(process.env)) {
        if (/^(CHROME_|AMO_)/.test(key) && process.env[key]) {
            values[key] = process.env[key];
        }
    }
    values.__file = file;
    values.__exists = fs.existsSync(file);
    return values;
}

function requireCreds(creds, keys) {
    const missing = keys.filter((key) => !creds[key]);
    if (missing.length) {
        const where = creds.__exists ? creds.__file : creds.__file + ' (file does not exist)';
        throw Object.assign(
            new Error('Missing credentials: ' + missing.join(', ') + '. Expected in ' + where),
            { exitCode: EXIT.CREDENTIALS }
        );
    }
}

async function fetchWithRetry(url, options, retries) {
    const attempts = (retries === undefined ? 2 : retries) + 1;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(90000) }, options));
            if (res.status >= 500 && attempt < attempts) {
                warn('HTTP ' + res.status + ' from ' + url + ', retrying (' + attempt + '/' + (attempts - 1) + ')');
                await sleep(2000 * attempt);
                continue;
            }
            return res;
        } catch (err) {
            lastError = err;
            if (attempt < attempts) {
                warn('Network error on ' + url + ': ' + err.message + ', retrying (' + attempt + '/' + (attempts - 1) + ')');
                await sleep(2000 * attempt);
                continue;
            }
        }
    }
    throw Object.assign(new Error('Network failure calling ' + url + ': ' + (lastError && lastError.message)), {
        exitCode: EXIT.NETWORK
    });
}

async function readBody(res) {
    const text = await res.text();
    try {
        return { text: text, json: text ? JSON.parse(text) : null };
    } catch (err) {
        void err;
        return { text: text, json: null };
    }
}

function zipEntries(zipPath) {
    const buf = fs.readFileSync(zipPath);
    let eocd = -1;
    const floor = Math.max(0, buf.length - 22 - 65535);
    for (let i = buf.length - 22; i >= floor; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error('Not a zip archive (no end of central directory): ' + zipPath);
    }
    const count = buf.readUInt16LE(eocd + 10);
    if (count === 0xffff) {
        throw new Error('Zip64 archive is not supported by this reader: ' + zipPath);
    }
    let offset = buf.readUInt32LE(eocd + 16);
    const names = [];
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('Corrupt central directory in ' + zipPath);
        }
        const nameLen = buf.readUInt16LE(offset + 28);
        const extraLen = buf.readUInt16LE(offset + 30);
        const commentLen = buf.readUInt16LE(offset + 32);
        names.push(buf.toString('utf8', offset + 46, offset + 46 + nameLen));
        offset += 46 + nameLen + extraLen + commentLen;
    }
    return names;
}

// Reads one entry out of the archive. The dist folder is not a stand-in for the
// zip: a later development build overwrites dist while the zip that ships stays
// as it was, so a check that reads dist can fail a good package or pass a bad one.
function zipReadText(zipPath, entryName) {
    const buf = fs.readFileSync(zipPath);
    let eocd = -1;
    const floor = Math.max(0, buf.length - 22 - 65535);
    for (let i = buf.length - 22; i >= floor; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error('Not a zip archive (no end of central directory): ' + zipPath);
    }

    const count = buf.readUInt16LE(eocd + 10);
    let offset = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('Corrupt central directory in ' + zipPath);
        }
        const method = buf.readUInt16LE(offset + 10);
        const compressedSize = buf.readUInt32LE(offset + 20);
        const nameLen = buf.readUInt16LE(offset + 28);
        const extraLen = buf.readUInt16LE(offset + 30);
        const commentLen = buf.readUInt16LE(offset + 32);
        const localOffset = buf.readUInt32LE(offset + 42);
        const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

        if (name === entryName) {
            if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
                throw new Error('Corrupt local header for ' + entryName + ' in ' + zipPath);
            }
            const localNameLen = buf.readUInt16LE(localOffset + 26);
            const localExtraLen = buf.readUInt16LE(localOffset + 28);
            const start = localOffset + 30 + localNameLen + localExtraLen;
            const data = buf.subarray(start, start + compressedSize);
            if (method === 0) {
                return data.toString('utf8');
            }
            if (method === 8) {
                return zlib.inflateRawSync(data).toString('utf8');
            }
            throw new Error('Unsupported zip compression method ' + method + ' for ' + entryName);
        }

        offset += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error(entryName + ' is not present in ' + zipPath);
}

function walkFiles(dir, base) {
    const root = base || dir;
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walkFiles(full, root));
        } else {
            out.push(path.relative(root, full).split(path.sep).join('/'));
        }
    }
    return out;
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = {
    ROOT,
    STATE_DIR,
    EXIT,
    RESULT_MARKER,
    CHROME_ITEM_ID,
    AMO_ADDON_GUID,
    CHROME_DASHBOARD,
    CHROME_LISTING,
    NEXUS_LISTING,
    AMO_DASHBOARD,
    AMO_LISTING,
    log,
    step,
    warn,
    errline,
    buildResult,
    writeResult,
    emit,
    finish,
    isFinished,
    guard,
    parseArgs,
    readJson,
    writeJson,
    readState,
    writeState,
    acquireLock,
    sleep,
    run,
    runDirect,
    runBin,
    runNpm,
    runGit,
    runNode,
    binPath,
    requireBin,
    writeTempFile,
    parseVersion,
    compareVersions,
    bumpVersion,
    credentialsPath,
    loadCredentials,
    requireCreds,
    fetchWithRetry,
    readBody,
    zipEntries,
    zipReadText,
    walkFiles,
    sha256
};
