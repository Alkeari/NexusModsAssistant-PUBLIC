'use strict';

/**
 * Records the fixtures in this directory from the live public endpoints.
 *
 * Run it with `node tests/fixtures/record.js`. It is NOT part of `npm test`: the suite
 * globs tests/*.test.js and never reaches this file, so the tests themselves make no
 * network request at all.
 *
 * Every fixture here is a real response, recorded by this script, from an endpoint that
 * needs no key and no account. Anyone can re-record them on any machine and get the same
 * kind of data, which is the whole point: nothing in the suite is knowledge that only
 * exists on one developer's disk.
 *
 * Where a response was trimmed, the trimming is done here, in code, and stated in the
 * TARGETS table below. Nothing inside a kept item is edited.
 */

const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const TIMEOUT_MS = 45000;

// The same URL src/background/background.ts posts to. A fixture recorded from a different
// host is evidence about a different endpoint than the one under test, however alike the
// two answer today.
const GRAPHQL = 'https://api.nexusmods.com/v2/graphql';

// Filled per target so the URL each fixture really came from is written into provenance
// rather than described in prose beside it.
let urlsUsed = [];

async function getJson(url, init) {
    urlsUsed.push(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (!response.ok) throw new Error(`${url} answered ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

function graphql(query) {
    return getJson(GRAPHQL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
}

const collectionQuery = (domain) =>
    `{ collectionsV2(filter:{gameDomain:{value:"${domain}",op:EQUALS}}, count:50){ nodes { currentRevision { gameVersions { reference } } } } }`;

const collectionTarget = (domain) => ({
    file: `nexus-collections-${domain}.json`,
    note: `Nexus GraphQL collectionsV2 for gameDomain "${domain}", keyless. Whole response.`,
    fetch: () => graphql(collectionQuery(domain))
});

const TARGETS = [
    {
        file: 'steam-news-294100.json',
        note: 'ISteamNews GetNewsForApp for appid 294100 (RimWorld), feeds=steam_community_announcements. First 20 newsitems kept whole.',
        fetch: async () => {
            const json = await getJson('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=294100&count=100&feeds=steam_community_announcements');
            json.appnews.newsitems = json.appnews.newsitems.slice(0, 20);
            return json;
        }
    },
    {
        file: 'steam-news-261550.json',
        note: 'ISteamNews GetNewsForApp for appid 261550 (Mount & Blade II: Bannerlord), feeds=steam_community_announcements. First 20 newsitems kept whole.',
        fetch: async () => {
            const json = await getJson('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=261550&count=100&feeds=steam_community_announcements');
            json.appnews.newsitems = json.appnews.newsitems.slice(0, 20);
            return json;
        }
    },
    {
        file: 'steam-news-1091500.json',
        note: 'ISteamNews GetNewsForApp for appid 1091500 (Cyberpunk 2077), feeds=steam_community_announcements. First 45 newsitems kept whole. That window reaches from the newest announcement back past 2.0, so it holds both the zero-padded builds (2.01, 2.02) and the pair a generic comparator cannot rank (2.2 announced after 2.13).',
        fetch: async () => {
            const json = await getJson('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=1091500&count=100&feeds=steam_community_announcements');
            json.appnews.newsitems = json.appnews.newsitems.slice(0, 45);
            return json;
        }
    },
    {
        file: 'steamcmd-261550.json',
        note: 'api.steamcmd.net app info for 261550. Whole response: 47 branches, most of them version names.',
        fetch: () => getJson('https://api.steamcmd.net/v1/info/261550')
    },
    {
        file: 'steamcmd-294100.json',
        note: 'api.steamcmd.net app info for 294100. Whole response: 21 branches, none of them version-shaped.',
        fetch: () => getJson('https://api.steamcmd.net/v1/info/294100')
    },
    {
        file: 'nexus-mods-rimworld.json',
        note: 'Nexus GraphQL mods for gameDomainName "rimworld", keyless, count 50. Whole response, nodes untouched, fields as queried. Mods use gameDomainName; collections use gameDomain.',
        fetch: () => graphql('{ mods(filter:{gameDomainName:{value:"rimworld",op:EQUALS}}, count:50){ nodes { modId name version summary description } } }')
    },
    collectionTarget('skyrimspecialedition'),
    collectionTarget('rimworld'),
    collectionTarget('cyberpunk2077'),
    collectionTarget('starfield'),
    collectionTarget('fallout4'),
    collectionTarget('baldursgate3'),
    collectionTarget('mountandblade2bannerlord'),
    {
        file: 'nexus-games-by-name.json',
        note: 'One keyless Nexus GraphQL games query per search term, each response kept whole and stored under its term. The games query is the only place a game display name can be derived from, and the display name is what the mod-text cue is built out of.',
        fetch: async () => {
            const terms = ['RimWorld', 'DiRT 2', 'Mount & Blade II: Bannerlord', 'Skyrim Special Edition', 'Signalis'];
            const out = {};
            for (const term of terms) {
                out[term] = await graphql(`{ games(filter:{name:[{value:"${term}",op:WILDCARD}]}){ totalCount nodes { id name domainName modCount } } }`);
            }
            return out;
        }
    },
    {
        file: 'steam-storesearch-dirt2.json',
        note: 'Steam store search for the term "DiRT 2". Whole response. This is the mis-bind: the first app is DiRT Rally 2.0, appid 690790, a different game.',
        fetch: () => getJson('https://store.steampowered.com/api/storesearch/?term=DiRT%202&cc=US&l=en')
    },
    {
        file: 'steam-storesearch-rimworld.json',
        note: 'Steam store search for the term "RimWorld". Whole response. The first app is an exact name match, appid 294100.',
        fetch: () => getJson('https://store.steampowered.com/api/storesearch/?term=RimWorld&cc=US&l=en')
    }
];

async function main() {
    const manifest = {};
    for (const target of TARGETS) {
        process.stdout.write(`recording ${target.file} ... `);
        urlsUsed = [];
        const json = await target.fetch();
        fs.writeFileSync(path.join(HERE, target.file), `${JSON.stringify(json, null, 1)}\n`);
        const urls = Array.from(new Set(urlsUsed));
        manifest[target.file] = `${urls.join(' , ')} :: ${target.note}`;
        process.stdout.write('ok\n');
    }
    fs.writeFileSync(path.join(HERE, 'provenance.json'), `${JSON.stringify({
        recordedAt: new Date().toISOString().slice(0, 10),
        recordedBy: 'tests/fixtures/record.js',
        sources: manifest
    }, null, 1)}\n`);
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
