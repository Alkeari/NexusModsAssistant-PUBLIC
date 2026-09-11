'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nma = require('../scripts/lib/nma.js');

// scripts/lib/nma.js is the shared library every release script runs through. It is not
// shipped in the extension, but a defect here mis-publishes a build, which is the one
// class of mistake that cannot be undone from the store side.

test.describe('parseArgs: the flags every release script is driven by', () => {
    test('a real preflight invocation parses as written', () => {
        assert.deepEqual(nma.parseArgs(['--scope', 'release']), {_: [], scope: 'release'});
        assert.deepEqual(nma.parseArgs(['--dry-run']), {_: [], 'dry-run': true});
    });

    test('a flag with no value is true, not the next flag name', () => {
        assert.deepEqual(nma.parseArgs(['--dry-run', '--scope', 'release']), {
            _: [],
            'dry-run': true,
            scope: 'release'
        });
        assert.deepEqual(nma.parseArgs(['--verbose']), {_: [], verbose: true});
    });

    test('positional arguments collect separately from flags', () => {
        assert.deepEqual(nma.parseArgs(['chrome', 'firefox', '--dry-run']), {
            _: ['chrome', 'firefox'],
            'dry-run': true
        });
    });

    test('a positional that follows a flag is swallowed as that flag value', () => {
        // Recorded, not endorsed. The parser has no notion of which flags take a value,
        // so `--dry-run firefox` means dry-run="firefox" and the browser argument is
        // gone. Every positional has to be written before the first flag.
        assert.deepEqual(nma.parseArgs(['chrome', '--dry-run', 'firefox']), {
            _: ['chrome'],
            'dry-run': 'firefox'
        });
    });

    test('no arguments yields an empty positional list, never undefined', () => {
        // Every caller does `args._` immediately; undefined here throws inside the script
        // rather than at its boundary.
        assert.deepEqual(nma.parseArgs([]), {_: []});
    });

    test('a value that begins with two dashes is read as the next flag', () => {
        // Recorded, not endorsed. The consequence is real: `--notes --dry-run` silently
        // loses the notes and turns on the dry run, so a value that can start with two
        // dashes has to be passed through a file rather than the command line.
        assert.deepEqual(nma.parseArgs(['--notes', '--dry-run']), {
            _: [],
            notes: true,
            'dry-run': true
        });
    });

    test('a negative number survives as a value', () => {
        assert.deepEqual(nma.parseArgs(['--offset', '-5']), {_: [], offset: '-5'});
    });

    test('a repeated flag takes its last value', () => {
        assert.deepEqual(nma.parseArgs(['--scope', 'release', '--scope', 'local']), {_: [], scope: 'local'});
    });

    test('a Windows path containing spaces stays one value', () => {
        // Release paths on Windows routinely contain spaces. A parser that split on
        // spaces would break every path the release pipeline handles.
        const args = nma.parseArgs(['--source', 'D:\\Build Output\\Nexus Mods Assistant']);
        assert.equal(args.source, 'D:\\Build Output\\Nexus Mods Assistant');
    });
});

test.describe('run: the shell-truncation guard', () => {
    test('a newline inside an argument is refused before anything is spawned', () => {
        // On Windows every token goes through cmd.exe with shell:true. A newline
        // terminates the command line, so the rest is dropped and the process exits 0.
        // A silent success on a truncated publish command is the worst possible outcome.
        assert.throws(() => nma.run('git', ['commit', '-m', 'line one\nline two']), /multi-line argument/);
    });

    test('a carriage return is refused as well as a line feed', () => {
        // Release notes pasted from a Windows editor arrive as CRLF.
        assert.throws(() => nma.run('git', ['commit', '-m', 'line one\r\nline two']), /multi-line argument/);
        assert.throws(() => nma.run('git', ['commit', '-m', 'line one\rline two']), /multi-line argument/);
    });

    test('the guard names the supported alternative rather than just refusing', () => {
        // A refusal with no path forward stalls a release at the worst moment.
        assert.throws(() => nma.run('git', ['commit', '-m', 'a\nb']), /runDirect|-F file/);
    });

    test('the guard rejects synchronously, so no child process is left behind', () => {
        // If it rejected inside the returned promise instead, the spawn would already
        // have happened by the time the caller saw the error.
        let threw = false;
        try {
            nma.run('git', ['status', 'a\nb']);
        } catch {
            threw = true;
        }
        assert.equal(threw, true);
    });
});

test.describe('bumpVersion and compareVersions agree with each other', () => {
    test('a patch bump of the shipped version is strictly newer', () => {
        // The store rejects a re-upload at the same version, and the extension is on
        // 3.1.0 today.
        assert.equal(nma.compareVersions(nma.bumpVersion('3.1.0', 'patch'), '3.1.0'), 1);
        assert.equal(nma.bumpVersion('3.1.0', 'patch'), '3.1.1');
    });
});
