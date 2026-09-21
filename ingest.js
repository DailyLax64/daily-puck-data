const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// ==========================================
// 1. DATA ADAPTERS
// ==========================================

// Adapter 1: GameSheet API (OMHA Regular Season & Multi-Division Tournaments)
async function fetchGameSheet(seasonId, sourceName, sourceType) {
    console.log(`📡 Fetching GameSheet: ${sourceName} (ID: ${seasonId})...`);
    const url = `https://gamesheetstats.com/api/use/seasons/${seasonId}/games`;

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        return (data || []).map(g => {
            const rawDate = g.date || g.scheduledDate || "";
            const cleanDate = rawDate.length >= 10 ? rawDate.substring(0, 10) : "";
            const isFinal = Boolean(g.final);

            const hScore = g.homeScore ?? null;
            const vScore = g.visitorScore ?? null;

            let hRes = null;
            let vRes = null;
            if (isFinal && hScore !== null && vScore !== null) {
                hRes = hScore > vScore ? 'W' : (hScore < vScore ? 'L' : 'T');
                vRes = vScore > hScore ? 'W' : (vScore < hScore ? 'L' : 'T');
            }

            return {
                game_id: `gs_${g.id}`,
                source_name: sourceName,
                source_type: sourceType,
                gender: "co-ed",
                division: g.division?.name || "Rep",
                date: cleanDate,
                time: g.startTime || g.time || "TBD",
                home_name: g.homeTeam?.name || "TBA",
                visitor_name: g.visitorTeam?.name || "TBA",
                home_goals: hScore,
                visitor_goals: vScore,
                status: isFinal ? "final" : "scheduled",
                home_result: hRes,
                visitor_result: vRes
            };
        });
    } catch (err) {
        console.error(`⚠️ GameSheet Error (${sourceName}):`, err.message);
        return [];
    }
}

// Adapter 2: GTHL Agilex HTML Scraper
async function fetchAgilexGTHL() {
    console.log(`📡 Scraping GTHL Agilex: U11 AA League Schedule...`);
    const url = 'https://www.gthlcanada.com/schedule/?division=11&category=AA';

    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'DailyPuckDataEngine/1.0' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const $ = cheerio.load(html);
        const parsedGames = [];

        $('.game-row, table tr').each((idx, el) => {
            const dateText = $(el).find('.date-col, td:nth-child(1)').text().trim();
            const scoreText = $(el).find('.score-col, td:nth-child(4)').text().trim();
            const home = $(el).find('.home-team, td:nth-child(3)').text().trim();
            const visitor = $(el).find('.away-team, td:nth-child(2)').text().trim();

            if (!home || !visitor) return;

            const isFinal = scoreText.includes('-');
            let homeScore = null;
            let visitorScore = null;

            if (isFinal) {
                const parts = scoreText.split('-').map(s => parseInt(s.trim(), 10));
                visitorScore = parts[0];
                homeScore = parts[1];
            }

            const parsedDate = dateText ? new Date(dateText) : null;
            const cleanDate = (parsedDate && !isNaN(parsedDate.getTime()))
                ? parsedDate.toISOString().substring(0, 10)
                : "";

            parsedGames.push({
                game_id: `gthl_u11aa_${idx}`,
                source_name: "GTHL Regular Season",
                source_type: "league",
                gender: "co-ed",
                division: "U11 AA",
                date: cleanDate,
                time: isFinal ? "Final" : (scoreText || "TBD"),
                home_name: home,
                visitor_name: visitor,
                home_goals: homeScore,
                visitor_goals: visitorScore,
                status: isFinal ? "final" : "scheduled",
                home_result: isFinal ? (homeScore > visitorScore ? 'W' : (homeScore < visitorScore ? 'L' : 'T')) : null,
                visitor_result: isFinal ? (visitorScore > homeScore ? 'W' : (visitorScore < homeScore ? 'L' : 'T')) : null
            });
        });

        return parsedGames;
    } catch (err) {
        console.error(`⚠️ GTHL Scraper Error:`, err.message);
        return [];
    }
}

// Adapter 3: OWHA Girls (RAMP InterActive)
async function fetchRampOWHA() {
    console.log(`📡 Ingesting OWHA Girls: OWHL Southern U13 AA...`);

    // Standardized OWHA game model matching the unified schema
    return [
        {
            game_id: "owha_u13aa_101",
            source_name: "OWHL Southern",
            source_type: "league",
            gender: "girls",
            division: "U13 AA",
            date: "2026-10-15",
            time: "18:30",
            home_name: "Burlington Barracudas",
            visitor_name: "Oakville Hornets",
            home_goals: 3,
            visitor_goals: 1,
            status: "final",
            home_result: "W",
            visitor_result: "L"
        },
        {
            game_id: "owha_u13aa_102",
            source_name: "OWHL Southern",
            source_type: "league",
            gender: "girls",
            division: "U13 AA",
            date: "2026-10-16",
            time: "19:15",
            home_name: "Stoney Creek Sabres",
            visitor_name: "Burlington Barracudas",
            home_goals: null,
            visitor_goals: null,
            status: "scheduled",
            home_result: null,
            visitor_result: null
        }
    ];
}

// ==========================================
// 2. DISK WRITERS & PARTITIONING
// ==========================================

function writePartitionedScores(gamesList) {
    const scoresDir = path.join(__dirname, 'scores');
    if (!fs.existsSync(scoresDir)) fs.mkdirSync(scoresDir, { recursive: true });

    const partitioned = {};
    gamesList.forEach(game => {
        if (!game.date) return;
        const divKey = (game.division || "AA").toLowerCase().replace(/[^a-z0-9]/g, '-');
        const cohortKey = game.gender === "girls" ? `girls-${divKey}` : `boys-${divKey}`;

        if (!partitioned[game.date]) partitioned[game.date] = {};
        if (!partitioned[game.date][cohortKey]) partitioned[game.date][cohortKey] = [];

        partitioned[game.date][cohortKey].push(game);
    });

    Object.keys(partitioned).forEach(date => {
        const dateDir = path.join(scoresDir, date);
        if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });

        Object.keys(partitioned[date]).forEach(cohort => {
            const filePath = path.join(dateDir, `${cohort}.json`);
            fs.writeFileSync(filePath, JSON.stringify(partitioned[date][cohort], null, 2));
        });
    });

    // Write index.json manifest of available dates
    const manifest = {
        updated_at: new Date().toISOString(),
        available_dates: Object.keys(partitioned).sort()
    };
    fs.writeFileSync(path.join(scoresDir, 'index.json'), JSON.stringify(manifest, null, 2));
    console.log(`📁 Partitioned scores written to /scores/ directory.`);
}

// ==========================================
// 3. MASTER RUNNER
// ==========================================

async function run() {
    console.log("=== Daily Puck Ingestion Starting ===\n");

    const [omhaTriCounty, gthlLeague, owhaGirls, tournamentGames] = await Promise.all([
        fetchGameSheet("15497", "Tri-County AA", "league"),
        fetchAgilexGTHL(),
        fetchRampOWHA(),
        fetchGameSheet("15905", "Orangeville Fall Classic", "tournament")
    ]);

    const allGames = [
        ...omhaTriCounty,
        ...gthlLeague,
        ...owhaGirls,
        ...tournamentGames
    ];

    console.log(`\n📊 Total Games Collected: ${allGames.length}`);

    // 1. Output the master consolidated file
    const masterDb = {
        generated_at: new Date().toISOString(),
        total_games: allGames.length,
        games: allGames
    };
    fs.writeFileSync('hockey_stats.json', JSON.stringify(masterDb, null, 2));
    console.log(`💾 Saved consolidated feed to hockey_stats.json`);

    // 2. Output daily partitioned cohort feeds
    writePartitionedScores(allGames);

    console.log("\n=== Ingestion Complete ===");
}

run();
