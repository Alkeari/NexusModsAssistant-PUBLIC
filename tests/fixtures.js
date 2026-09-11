'use strict';

/**
 * Recorded responses, and where each one came from.
 *
 * Every file in tests/fixtures is a real answer from a public, keyless endpoint, written
 * by tests/fixtures/record.js. The suite never makes a network request: it reads these.
 * provenance.json carries the URL and the trimming rule for each file, and every fixture
 * this module hands out is checked against it, so a fixture that appeared from nowhere
 * fails the run rather than passing quietly.
 */

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'fixtures');

const provenance = JSON.parse(fs.readFileSync(path.join(DIR, 'provenance.json'), 'utf8'));

const cache = new Map();

function load(file) {
    if (!provenance.sources[file]) {
        throw new Error(`tests/fixtures/${file} has no entry in provenance.json. A fixture with no stated source is not evidence.`);
    }
    if (!cache.has(file)) {
        cache.set(file, JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')));
    }
    return cache.get(file);
}

function sourceOf(file) {
    return provenance.sources[file] || null;
}

function fixtureFiles() {
    return fs.readdirSync(DIR).filter(name => name.endsWith('.json') && name !== 'provenance.json');
}

/** gameVersions.reference strings exactly as one collectionsV2 response carried them. */
function collectionReferences(domain) {
    const json = load(`nexus-collections-${domain}.json`);
    const out = [];
    for (const node of json.data.collectionsV2.nodes) {
        for (const entry of node.currentRevision?.gameVersions || []) {
            out.push(entry.reference);
        }
    }
    return out;
}

/** The display name Nexus itself publishes for a domain, which is all a cue can be built from. */
function nexusGame(term, domain) {
    const json = load('nexus-games-by-name.json')[term];
    if (!json) throw new Error(`nexus-games-by-name.json holds no response for the term ${JSON.stringify(term)}`);
    const node = json.data.games.nodes.find(candidate => candidate.domainName === domain);
    if (!node) throw new Error(`the recorded response for ${JSON.stringify(term)} holds no game with domain ${domain}`);
    return node;
}

module.exports = {
    DIR,
    load,
    sourceOf,
    fixtureFiles,
    provenance,
    collectionReferences,
    nexusGame,
    modNodes: () => load('nexus-mods-rimworld.json').data.mods.nodes,
    steamNews: (appId) => load(`steam-news-${appId}.json`),
    steamAppInfo: (appId) => load(`steamcmd-${appId}.json`),
    storeSearch: (slug) => load(`steam-storesearch-${slug}.json`)
};
